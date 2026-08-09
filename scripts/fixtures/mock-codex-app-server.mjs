import readline from 'node:readline';

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let approvalIndex = -1;
let authenticated = process.env.TUNACAD_MOCK_LOGIN_REQUIRED !== '1';
let pendingLogin = null;
const approvalRequests = [
  {
    id: 700,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread:mock', turnId: 'turn:approval', itemId: 'item:command', startedAtMs: 1,
      command: 'npm.cmd test', cwd: 'C:\\TunaCAD', reason: 'Run deterministic tests.',
      availableDecisions: ['accept', 'decline', 'cancel'],
    },
  },
  {
    id: 701,
    method: 'item/fileChange/requestApproval',
    params: {
      threadId: 'thread:mock', turnId: 'turn:approval', itemId: 'item:file', startedAtMs: 2,
      reason: 'Apply the test patch.', grantRoot: 'C:\\TunaCAD',
    },
  },
  {
    id: 702,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread:mock', turnId: 'turn:approval', itemId: 'item:network', startedAtMs: 3,
      reason: 'Contact TunaCAD.',
      networkApprovalContext: { host: 'tunacad.com', protocol: 'https' },
      availableDecisions: ['accept', 'decline', 'cancel'],
    },
  },
];

const sendNextApproval = () => {
  approvalIndex += 1;
  if (approvalIndex < approvalRequests.length) {
    send(approvalRequests[approvalIndex]);
    return;
  }
  send({ method: 'item/completed', params: {
    threadId: 'thread:mock', turnId: 'turn:approval',
    item: { id: 'item:network', type: 'commandExecution', status: 'completed' },
  } });
  send({ method: 'turn/completed', params: {
    threadId: 'thread:mock', turn: { id: 'turn:approval', status: 'completed', items: [] },
  } });
};

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (!message.method && approvalRequests.some((request) => request.id === message.id)) {
    send({ method: 'serverRequest/resolved', params: { threadId: 'thread:mock', requestId: message.id } });
    sendNextApproval();
    return;
  }
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'mock-codex/0.146.0' } });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'account/read') {
    send({ id: message.id, result: authenticated
      ? { account: { type: 'chatgpt', planType: 'test' }, requiresOpenaiAuth: true }
      : { account: null, requiresOpenaiAuth: true } });
    return;
  }
  if (message.method === 'account/login/start') {
    if (message.params?.type !== 'chatgptDeviceCode') {
      send({ id: message.id, error: { code: -32602, message: 'Expected chatgptDeviceCode.' } });
      return;
    }
    const loginId = '6deca20b-f0bd-427c-8e5c-fbe7fcbab265';
    const delayMs = Number(process.env.TUNACAD_MOCK_LOGIN_DELAY_MS ?? 25);
    send({ id: message.id, result: {
      type: 'chatgptDeviceCode',
      loginId,
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'TUNA-CAD1',
    } });
    const timer = setTimeout(() => {
      if (pendingLogin?.loginId !== loginId) return;
      pendingLogin = null;
      authenticated = true;
      send({ method: 'account/login/completed', params: { loginId, success: true, error: null } });
      send({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'test' } });
    }, delayMs);
    pendingLogin = { loginId, timer };
    return;
  }
  if (message.method === 'account/login/cancel') {
    if (!pendingLogin || message.params?.loginId !== pendingLogin.loginId) {
      send({ id: message.id, error: { code: -32602, message: 'Unknown login ID.' } });
      return;
    }
    const { loginId, timer } = pendingLogin;
    clearTimeout(timer);
    pendingLogin = null;
    send({ id: message.id, result: {} });
    send({ method: 'account/login/completed', params: { loginId, success: false, error: 'cancelled' } });
    return;
  }
  if (message.method === 'config/read') {
    send({ id: message.id, result: { config: { mcp_servers: { tunacad: {
      url: process.env.TUNACAD_MOCK_MCP_URL ?? 'https://tunacad.invalid/mcp/probe',
      bearer_token_env_var: 'TUNACAD_MCP_AGENT_TOKEN',
      required: true,
    } } } } });
    return;
  }
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread:mock', ephemeral: true } } });
    send({ method: 'thread/started', params: { thread: { id: 'thread:mock' } } });
    return;
  }
  if (message.method === 'turn/start') {
    const prompt = message.params?.input?.map?.((entry) => entry.text ?? '').join(' ') ?? '';
    if (prompt.includes('APPROVAL_LIFECYCLE')) {
      approvalIndex = -1;
      send({ id: message.id, result: { turn: { id: 'turn:approval', status: 'inProgress', items: [] } } });
      send({ method: 'turn/started', params: {
        threadId: 'thread:mock', turn: { id: 'turn:approval', status: 'inProgress', items: [] },
      } });
      sendNextApproval();
      return;
    }
    if (prompt.includes('INTERRUPT_LIFECYCLE')) {
      send({ id: message.id, result: { turn: { id: 'turn:interrupt', status: 'inProgress', items: [] } } });
      send({ method: 'turn/started', params: {
        threadId: 'thread:mock', turn: { id: 'turn:interrupt', status: 'inProgress', items: [] },
      } });
      return;
    }
    send({ id: message.id, result: { turn: { id: 'turn:mock', status: 'inProgress', items: [] } } });
    send({ method: 'turn/started', params: {
      threadId: 'thread:mock', turn: { id: 'turn:mock', status: 'inProgress', items: [] },
    } });
    send({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread:mock', turnId: 'turn:mock', itemId: 'item:mock', delta: 'TUNACAD_APP_SERVER_PROBE_OK',
    } });
    send({ method: 'turn/completed', params: {
      threadId: 'thread:mock', turn: { id: 'turn:mock', status: 'completed', items: [] },
    } });
    return;
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    send({ method: 'turn/completed', params: {
      threadId: message.params.threadId,
      turn: { id: message.params.turnId, status: 'interrupted', items: [] },
    } });
    return;
  }
  if (message.method === 'turn/steer') {
    if (!message.params?.expectedTurnId || 'turnId' in message.params) {
      send({ id: message.id, error: { code: -32602, message: 'expectedTurnId is required and turnId is not accepted.' } });
      return;
    }
    send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } });
});
