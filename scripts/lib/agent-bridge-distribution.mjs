import { createHash } from 'node:crypto';

export const AGENT_BRIDGE_RELEASE_REPOSITORY = 'JNaruto-mar/TunaCAD-Agent-Bridge';
export const AGENT_BRIDGE_RELEASE_WORKFLOW = '.github/workflows/publish.yml';

export function parseNpmPackMetadata(serialized) {
  const parsed = JSON.parse(serialized);
  if (Array.isArray(parsed) && parsed.length !== 1) {
    throw new Error('npm pack must describe exactly one package.');
  }
  const metadata = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || typeof metadata.name !== 'string'
    || typeof metadata.version !== 'string'
    || typeof metadata.filename !== 'string'
    || typeof metadata.integrity !== 'string'
    || !Array.isArray(metadata.files)) {
    throw new Error('npm pack returned invalid package metadata.');
  }
  return metadata;
}

export function createAgentBridgeReleaseManifest({
  packageName,
  packageVersion,
  tarballFileName,
  tarballBytes,
  assemblyBytes,
  sourceCommit,
}) {
  if (packageName !== '@tunacad/agent-bridge') throw new Error('Unexpected release package name.');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageVersion)) throw new Error('Invalid release version.');
  if (tarballFileName !== `tunacad-agent-bridge-${packageVersion}.tgz`) {
    throw new Error('Release tarball filename does not match the package version.');
  }
  if (!/^[a-f0-9]{40}$/i.test(sourceCommit)) throw new Error('Release source commit must be a full Git SHA.');
  if (!(tarballBytes instanceof Uint8Array) || tarballBytes.byteLength === 0) throw new Error('Release tarball is empty.');
  if (!(assemblyBytes instanceof Uint8Array) || assemblyBytes.byteLength === 0) throw new Error('Assembly manifest is empty.');

  const artifact = {
    schemaVersion: 1,
    artifactType: 'tunacad-agent-bridge-npm-release',
    package: {
      name: packageName,
      version: packageVersion,
      exactSpecifier: `${packageName}@${packageVersion}`,
      tarballFileName,
      tarballBytes: tarballBytes.byteLength,
    },
    source: {
      repository: AGENT_BRIDGE_RELEASE_REPOSITORY,
      commit: sourceCommit.toLowerCase(),
      workflow: AGENT_BRIDGE_RELEASE_WORKFLOW,
    },
    digests: {
      tarballSha256: digest('sha256', tarballBytes, 'hex'),
      tarballSha512Integrity: `sha512-${digest('sha512', tarballBytes, 'base64')}`,
      assemblySha256: digest('sha256', assemblyBytes, 'hex'),
    },
    trustPolicy: {
      publisher: 'npm_trusted_publishing_github_oidc',
      npmRegistrySignatureRequired: true,
      npmSigstoreProvenanceRequired: true,
      githubArtifactAttestationRequired: true,
      exactVersionRequired: true,
      verificationCommands: ['npm_audit_signatures', 'gh_attestation_verify'],
    },
    platformPolicy: {
      portableNpmTarball: true,
      supportedOperatingSystems: ['win32', 'darwin', 'linux'],
      minimumNodeMajor: 20,
    },
    manualAcceptance: {
      physicalInstallUpdateUninstallPending: ['darwin', 'linux'],
    },
    redaction: {
      excludes: [
        'credentials', 'tokens', 'session_ids', 'account_ids', 'hostnames', 'usernames',
        'filesystem_paths', 'endpoints', 'prompts', 'chat_content', 'cad_content',
      ],
    },
  };
  return assertAgentBridgeReleaseManifest(artifact);
}

export function assertAgentBridgeReleaseManifest(artifact) {
  if (artifact?.schemaVersion !== 1 || artifact?.artifactType !== 'tunacad-agent-bridge-npm-release') {
    throw new Error('Invalid Agent Bridge release manifest identity.');
  }
  if (artifact.package?.name !== '@tunacad/agent-bridge'
    || artifact.package?.exactSpecifier !== `${artifact.package.name}@${artifact.package.version}`
    || artifact.package?.tarballFileName !== `tunacad-agent-bridge-${artifact.package.version}.tgz`
    || !Number.isSafeInteger(artifact.package?.tarballBytes)
    || artifact.package.tarballBytes <= 0) {
    throw new Error('Invalid Agent Bridge release package metadata.');
  }
  if (artifact.source?.repository !== AGENT_BRIDGE_RELEASE_REPOSITORY
    || artifact.source?.workflow !== AGENT_BRIDGE_RELEASE_WORKFLOW
    || !/^[a-f0-9]{40}$/.test(artifact.source?.commit ?? '')) {
    throw new Error('Invalid Agent Bridge trusted source identity.');
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.digests?.tarballSha256 ?? '')
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(artifact.digests?.tarballSha512Integrity ?? '')
    || !/^[a-f0-9]{64}$/.test(artifact.digests?.assemblySha256 ?? '')) {
    throw new Error('Invalid Agent Bridge release digest.');
  }
  const trust = artifact.trustPolicy;
  if (trust?.publisher !== 'npm_trusted_publishing_github_oidc'
    || trust.npmRegistrySignatureRequired !== true
    || trust.npmSigstoreProvenanceRequired !== true
    || trust.githubArtifactAttestationRequired !== true
    || trust.exactVersionRequired !== true
    || !trust.verificationCommands?.includes('npm_audit_signatures')
    || !trust.verificationCommands?.includes('gh_attestation_verify')) {
    throw new Error('Agent Bridge release trust policy is incomplete.');
  }
  if (artifact.platformPolicy?.portableNpmTarball !== true
    || artifact.platformPolicy?.minimumNodeMajor !== 20
    || !['win32', 'darwin', 'linux'].every((os) => artifact.platformPolicy.supportedOperatingSystems?.includes(os))) {
    throw new Error('Agent Bridge platform policy is incomplete.');
  }
  assertRedacted(artifact);
  return artifact;
}

export function verifyAgentBridgeReleaseFiles({ manifest, tarballBytes, assemblyBytes }) {
  assertAgentBridgeReleaseManifest(manifest);
  if (!(tarballBytes instanceof Uint8Array) || tarballBytes.byteLength !== manifest.package.tarballBytes) {
    throw new Error('Release tarball byte count does not match the manifest.');
  }
  if (digest('sha256', tarballBytes, 'hex') !== manifest.digests.tarballSha256
    || `sha512-${digest('sha512', tarballBytes, 'base64')}` !== manifest.digests.tarballSha512Integrity) {
    throw new Error('Release tarball digest verification failed.');
  }
  if (!(assemblyBytes instanceof Uint8Array)
    || digest('sha256', assemblyBytes, 'hex') !== manifest.digests.assemblySha256) {
    throw new Error('Assembly manifest digest verification failed.');
  }
  return manifest;
}

export function assertAgentBridgeReleaseTag(tag, version) {
  if (tag !== `agent-bridge-v${version}`) {
    throw new Error(`Release tag must be agent-bridge-v${version}.`);
  }
  return tag;
}

function assertRedacted(artifact) {
  const serialized = JSON.stringify(artifact);
  if (/https?:\/\/|wss?:\/\/|[A-Za-z]:\\|\/(?:Users|home)\//i.test(serialized)) {
    throw new Error('Release manifest exposed an endpoint or filesystem path.');
  }
  for (const forbiddenKey of ['hostname', 'username', 'cwd', 'pid', 'sessionId', 'accountId', 'token', 'credential', 'endpoint', 'prompt', 'content']) {
    if (hasKey(artifact, forbiddenKey)) throw new Error(`Release manifest exposed ${forbiddenKey}.`);
  }
}

function hasKey(value, forbiddenKey) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((entry) => hasKey(entry, forbiddenKey));
  return Object.entries(value).some(([key, entry]) => key === forbiddenKey || hasKey(entry, forbiddenKey));
}

function digest(algorithm, bytes, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}
