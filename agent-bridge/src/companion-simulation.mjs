// Companion hosts the existing canonical Bridge in-process. No second owner,
// storage system, credentials file or authorization implementation is added.
import {createHmac,randomBytes} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {relative,isAbsolute} from 'node:path';
import * as modules from 'node:module';
let nativeLoader;
export async function createCompanionSimulationBridge({origin,grant,inspectPipeline}){
 if(Number(process.versions.node.split('.')[0])<24)throw Error('SIMULATION_NODE_24_REQUIRED');
 const base=new URL('../../external/TunaCAD-Simulation-Bridge/',import.meta.url);
 if(!existsSync(new URL('simulation-bridge/server.mts',base)))throw Error('SIMULATION_BRIDGE_RUNTIME_UNAVAILABLE');
 if(!nativeLoader&&!process.execArgv.includes('--experimental-transform-types')){
  // Native Bridge already requires Node 24. Transform its parameter properties
  // with Node's own loader, preserving file URLs for native helper locations.
  const root=fileURLToPath(base);
  nativeLoader=modules.registerHooks({load(url,context,next){
   if(url.startsWith('file:')&&/\.(mts|ts)$/.test(url)){const path=fileURLToPath(url),r=relative(root,path);
    if(r&&!r.startsWith('..')&&!isAbsolute(r))return {format:'module',shortCircuit:true,source:modules.stripTypeScriptTypes(readFileSync(path,'utf8'),{mode:'transform',sourceUrl:url})};}
   return next(url,context);
  }});
 }
 const {openNativeProviderSettings,resolveConfiguredProviderPaths}=await import(new URL('simulation-bridge/providerSettings.mts',base));
 const {loadExternalPipeline}=await import(new URL('simulation-bridge/providers.mts',base));
 const {startSimulationBridge}=await import(new URL('simulation-bridge/server.mts',base));
 const settings=await(await openNativeProviderSettings()).readVerified(),paths=resolveConfiguredProviderPaths(settings.paths,process.env);
 const pipeline=await loadExternalPipeline(paths.gmshExecutable,paths.calculixExecutable,{discovery:false});
 if(grant.scope.capabilities.includes('explicit_structural_dynamics')&&pipeline.readiness.meshing.runtimeVersion==='4.15.2'){
  const {openExplicitBridgeRuntime}=await import(new URL('providers/openradioss/ExplicitBridgeRuntime.mts',base));
  pipeline.providerExplicit=await openExplicitBridgeRuntime(paths.gmshExecutable);pipeline.readiness.explicit=pipeline.providerExplicit?.capabilities??null;
 }
 // Constructor-only qualification observer; never supplied by browser/MCP JSON.
 await inspectPipeline?.(pipeline);
 const owner=await startSimulationBridge({...pipeline,port:0,allowedOrigin:origin,trustedSimulationSession:grant,
  async approve(){throw Error('TRUSTED_SESSION_MUST_NOT_REQUEST_PER_STAGE_CONSENT');}});
 try{
  const challenge=randomBytes(32).toString('hex');
  const headers={Origin:origin,'Content-Type':'application/json','X-TunaCAD-Simulation-Workspace':grant.scope.workspaceId,'X-TunaCAD-Simulation-Client':'manual'};
  const response=await fetch(owner.url+'/v1/pair',{method:'POST',headers,body:JSON.stringify({challenge:challenge,proof:createHmac('sha256',owner.pairingCode).update('client:'+challenge).digest('hex')})});
  const pairing=await response.json();if(!response.ok||pairing.serverProof!==createHmac('sha256',owner.pairingCode).update('server:'+challenge+':'+pairing.sessionToken).digest('hex'))throw Error('SIMULATION_PAIRING_FAILED');
  return {url:owner.url,sessionToken:pairing.sessionToken,expiresAt:pairing.expiresAt,readiness:pipeline.readiness,async close(){const state=await owner.endTrustedSession();if(!state.retainedJobs)await owner.close();return state;}};
 }catch(error){await owner.close();throw error;}
}
