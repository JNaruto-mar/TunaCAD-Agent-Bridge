import {authorizeSimulationSession,validateSimulationSessionScope} from '../../external/TunaCAD-Simulation-Bridge/simulation-bridge/trustedSimulationSession.mjs';
import {createCompanionSimulationBridge} from './companion-simulation.mjs';
import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CompanionTrustStore } from './companion-trust-store.mjs';
import { discoverCompanionAgents } from './companion-discovery.mjs';
import { exchangePairingCode, normalizeRelayOrigin, validateSessionId } from './relay-client.mjs';
import { RelayConnectionSupervisor } from './relay-connection-supervisor.mjs';

export const COMPANION_PORT = 47831;
export const COMPANION_PROTOCOL = 'tunacad.companion/1';
export const companionMac = (key, message) => createHmac('sha256', Buffer.from(key, 'hex')).update(message).digest('hex');
const equal = (a, b) => typeof b === 'string' && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

export async function startCompanion({
  port = COMPANION_PORT, origins = ['https://tunacad.com'], trustStore = new CompanionTrustStore(),
  approveTrust = async () => false, approveSimulation = async () => false, simulationBridgeFactory = createCompanionSimulationBridge, discover = discoverCompanionAgents,
  pair = exchangePairingCode, supervisorFactory = (options) => new RelayConnectionSupervisor(options),
  fetchImpl = fetch, now = Date.now,
} = {}) {
  const allowed = new Set(origins.map((value) => {
    const origin = normalizeRelayOrigin(value);
    const url = new URL(origin);
    if (origin !== 'https://tunacad.com' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Only TunaCAD and explicit loopback development origins are supported.');
    return origin;
  }));
  await trustStore.load();
  let agents = await discover();
  const sessions = new Map();
  const simulations = new Map();
  const authorizing = new Map();
  const nonces = new Map();
  let mutationBusy = false;
  const stopSession = async (id) => {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    clearInterval(entry.heartbeat);
    clearTimeout(entry.expiry);
    await entry.supervisor.close().catch(() => {});
    // Hosted revocation remains browser-owned; this credential lives only in memory.
    await fetchImpl(`${entry.relayOrigin}/api/ai/session/${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${entry.browserToken}`, Origin: entry.origin },
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  };
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    const host = `127.0.0.1:${server.address().port}`;
    const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    // Validate before CORS, discovery, or side effects.
    if (request.headers.host !== host || !allowed.has(origin) || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) return send(403, { error: 'Companion request rejected.' });
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      response.setHeader('Access-Control-Allow-Private-Network', 'true');
      return send(204, {});
    }
    const route = request.url;
    if (request.method === 'GET' && route === '/v1/discovery') return send(200, { protocol: COMPANION_PROTOCOL, companionVersion: '0.2.19', trusted: false });
    if (request.method !== 'POST' || !['/v1/trust', '/v1/status', '/v1/connect', '/v1/disconnect', '/v1/forget', '/v1/refresh','/v1/simulation/authorize','/v1/simulation/resume','/v1/simulation/revoke'].includes(route)) return send(404, { error: 'Unknown Companion operation.' });
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) return send(415, { error: 'JSON required.' });
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 4096) return send(413, { error: 'Request too large.' }); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (route === '/v1/trust') {
        if (mutationBusy || trustStore.records.size >= 32) return send(409, { error: 'Trust request unavailable.' });
        mutationBusy = true;
        try {
          if (!await approveTrust(origin)) return send(403, { error: 'Trust declined on this computer.' });
          const device = { id: crypto.randomUUID(), origin, key: randomBytes(32).toString('hex') };
          trustStore.records.set(device.id, device);
          try { await trustStore.save(); } catch (error) { trustStore.records.delete(device.id); throw error; }
          return send(201, { protocol: COMPANION_PROTOCOL, id: device.id, key: device.key });
        } finally { mutationBusy = false; }
      }
      const device = trustStore.records.get(body.id);
      const { timestamp, nonce, payload, proof } = body;
      if (!device || device.origin !== origin || !Number.isSafeInteger(timestamp) || Math.abs(now() - timestamp) > 30_000
        || typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce) || typeof payload !== 'string' || payload.length > 2048) return send(401, { error: 'Device trust required.' });
      const message = `${origin}\n${route}\n${timestamp}\n${nonce}\n${payload}`;
      if (!equal(companionMac(device.key, message), proof)) return send(401, { error: 'Device proof rejected.' });
      for (const [seen, expires] of nonces) if (expires < now()) nonces.delete(seen);
      if (nonces.has(nonce) || nonces.size >= 2048) return send(409, { error: 'Request replay rejected.' });
      nonces.set(nonce, now() + 60_000);
      const input = JSON.parse(payload);
      const signed = (result) => { const data = JSON.stringify(result); return send(200, { data, proof: companionMac(device.key, `${nonce}\n${data}`) }); };
      if (route === '/v1/status') return signed({ companionVersion: '0.2.19', trusted: true, agents });
      if(route.startsWith('/v1/simulation/')){
        if(typeof input.workspaceId!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(input.workspaceId))throw Error('Invalid simulation workspace');
        const key=device.id+'|'+input.workspaceId,current=simulations.get(key);
        if(route==='/v1/simulation/revoke'){if(authorizing.has(key))authorizing.get(key).cancelled=true;await current?.grant.revoke();return signed({revoked:true});}
        if(route==='/v1/simulation/resume'){
          if(!current)return signed({available:false});
          return signed({available:true,session:current.grant.status(),bridge:{url:current.owner.url,sessionToken:current.owner.sessionToken,expiresAt:Number.MAX_SAFE_INTEGER}});
        }
        if(mutationBusy||simulations.size>=4&&!current)return send(409,{error:'Simulation session unavailable.'});
        const scope=validateSimulationSessionScope(input),allowedClients=['manual',...agents.filter(a=>a.installed&&a.compatible).map(a=>a.id)];
        if(scope.clients.some(c=>!allowedClients.includes(c)))return send(403,{error:'Simulation client unavailable.'});
        mutationBusy=true;
        try{
          if(current){await current.grant.authorizeScope(scope);return signed({available:true,session:current.grant.status(),bridge:{url:current.owner.url,sessionToken:current.owner.sessionToken,expiresAt:Number.MAX_SAFE_INTEGER}});}
          const pending={cancelled:false};authorizing.set(key,pending);let owner,grant;
          grant=await authorizeSimulationSession({scope,deviceId:device.id,origin,approve:approveSimulation,
            resolveClient:async id=>{if(trustStore.records.get(device.id)!==device)throw Error('SIMULATION_SESSION_DEVICE_REVOKED');if(id==='manual')return 'manual';const live=sessions.get(id);if(!live||live.deviceId!==device.id||live.origin!==origin)throw Error('SIMULATION_SESSION_CLIENT_DENIED');return live.agentProvider;},
            onRevoke:async()=>{ /* Revoke admission only; active jobs/results drain normally. */ }});
          if(pending.cancelled||trustStore.records.get(device.id)!==device){await grant.revoke();throw Error('Simulation trust changed');}
          try{owner=await simulationBridgeFactory({origin,grant});if(grant.status().revoked){await owner.close();throw Error('Simulation authorization expired');}}
          catch(error){await grant.revoke();throw error;}
          simulations.set(key,{deviceId:device.id,grant,owner});
          return signed({available:true,session:grant.status(),bridge:{url:owner.url,sessionToken:owner.sessionToken,expiresAt:owner.expiresAt}});
        }finally{authorizing.delete(key);mutationBusy=false;}
      }
      if(route==='/v1/forget'){for(const [key,pending] of authorizing)if(key.startsWith(device.id+'|'))pending.cancelled=true;for(const item of simulations.values())if(item.deviceId===device.id)await item.grant.revoke();}
      if (mutationBusy) return send(409, { error: 'Companion operation in progress.' });
      mutationBusy = true;
      try {
        if (route === '/v1/refresh') { agents = await discover(); return signed({ companionVersion: '0.2.19', trusted: true, agents }); }
        if (route === '/v1/forget') {
          for(const [key,item] of [...simulations])if(item.deviceId===device.id){await item.grant.revoke();const state=await item.owner.close();if(state?.retainedJobs)throw Error('Save or intentionally cancel retained jobs before forgetting this device');simulations.delete(key);}
          trustStore.records.delete(device.id);
          try { await trustStore.save(); } catch (error) { trustStore.records.set(device.id, device); throw error; }
          for (const [id, entry] of sessions) if (entry.deviceId === device.id) await stopSession(id);
          return signed({ trusted: false });
        }
        validateSessionId(input.sessionId);
        if (route === '/v1/disconnect') {
          if (sessions.get(input.sessionId)?.deviceId === device.id) await stopSession(input.sessionId);
          return signed({ disconnected: true });
        }
        if (sessions.size >= 8 || sessions.has(input.sessionId)) return send(409, { error: 'Workspace session limit reached.' });
        if (!agents.some((agent) => agent.id === input.agent && agent.installed && agent.compatible)) return send(422, { error: 'A compatible installed AI CLI is required.' });
        const relayOrigin = normalizeRelayOrigin(input.relayOrigin);
        if (relayOrigin !== origin && !(new URL(origin).protocol === 'http:' && relayOrigin === 'https://tunacad.com')) return send(403, { error: 'Relay origin rejected.' });
        if (typeof input.browserToken !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(input.browserToken)
          || typeof input.code !== 'string' || input.code.length > 40) return send(400, { error: 'Invalid temporary session.' });
        const pairing = await pair({ origin: relayOrigin, sessionId: input.sessionId, code: input.code,
          fetchImpl: (url, options) => fetchImpl(url, { ...options, signal: AbortSignal.timeout(10_000) }) });
        if (new URL(pairing.mcpUrl).origin !== relayOrigin || new URL(pairing.bridgeWebSocketUrl).host !== new URL(relayOrigin).host
          || pairing.expiresAt <= now() || pairing.expiresAt > now() + 4 * 60 * 60_000 + 60_000) throw new Error('Invalid paired relay.');
        const supervisor = supervisorFactory({ pairing, agentProvider: input.agent });
        const entry = { supervisor, deviceId: device.id, browserToken: input.browserToken, origin, relayOrigin,agentProvider:input.agent };
        sessions.set(input.sessionId, entry);
        // Provider/relay errors can contain secrets; never log or serialize them.
        supervisor.on('failure', () => { void stopSession(input.sessionId); });
        supervisor.on('terminal', () => { void stopSession(input.sessionId); });
        try {
          const started = await supervisor.start();
          if (!sessions.has(input.sessionId)) throw new Error('Session stopped during startup.');
          entry.heartbeat = setInterval(() => supervisor.sendHeartbeat(), 15_000);
          entry.heartbeat.unref();
          entry.expiry = setTimeout(() => { void stopSession(input.sessionId); }, pairing.expiresAt - now());
          entry.expiry.unref();
          return signed({ connected: true, authenticationRequired: started.status === 'authentication_required' });
        } catch (error) { await stopSession(input.sessionId); throw error; }
      } finally { mutationBusy = false; }
    } catch(error) { if (!response.writableEnded) {
      const code=['SIMULATION_SESSION_DECLINED','SIMULATION_SESSION_REVOKED_DURING_REVIEW','SIMULATION_SESSION_CLIENT_DENIED','SIMULATION_PROVIDER_CONFIGURATION_CHANGED'].includes(error?.message)?error.message:undefined;
      send(400, { error: 'Companion operation failed. Check local setup and try again.',...(code?{code}:{}) });
    } }
  });
  server.requestTimeout = 130_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}`, async close() {
    for(const pending of authorizing.values())pending.cancelled=true;
    let retained=false;
    for(const item of [...simulations.values()]){await item.grant.revoke();const state=await item.owner.close();retained ||= Boolean(state?.retainedJobs);}
    if(retained)return {retainedJobs:true}; // Keep authenticated reconnect operational.
    for (const id of [...sessions.keys()]) await stopSession(id);
    await new Promise((resolve) => server.close(resolve));
  } };
}
