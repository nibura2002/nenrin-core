import {
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  createHash,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';

export function generateKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKey,
    publicKey,
    publicDerHex: der.toString('hex'),
    keyId: 'k:' + createHash('sha256').update(der).digest('hex').slice(0, 16),
  };
}

export function privateKeyToPem(privateKey) {
  return privateKey.export({ type: 'pkcs8', format: 'pem' });
}

export function privateKeyFromPem(pem) {
  return createPrivateKey(pem);
}

export function signHex(privateKey, data) {
  return cryptoSign(null, Buffer.from(data, 'utf8'), privateKey).toString('hex');
}

export function verifyHex(publicDerHex, data, sigHex) {
  const key = createPublicKey({ key: Buffer.from(publicDerHex, 'hex'), format: 'der', type: 'spki' });
  return cryptoVerify(null, Buffer.from(data, 'utf8'), key, Buffer.from(sigHex, 'hex'));
}
