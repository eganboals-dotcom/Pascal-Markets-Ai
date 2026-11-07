import { readFileSync } from 'node:fs';
import { createPrivateKey, sign, constants } from 'node:crypto';

export function signedHeaders(keyId, keyPath, method, path, now = Date.now(), label = 'Kalshi') {
  let key;
  try {
    key = createPrivateKey(readFileSync(keyPath));
    if (key.asymmetricKeyType !== 'rsa') throw new Error();
  } catch { throw new Error(`Unable to load ${label} RSA private key`); }
  const timestamp = String(now);
  return { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': sign('sha256', Buffer.from(timestamp + method + path), {
      key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST
    }).toString('base64') };
}
