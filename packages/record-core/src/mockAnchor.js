import { createHmac } from 'node:crypto';

// Stand-in for the NENRIN anchor server. The HMAC secret simulates the server's
// signing capability: the client cannot forge receipts for new chain heads.
const SERVER_SECRET = 'mock-nenrin-server-secret';

function receiptSig(anchorId, chainHead, receivedAt) {
  return createHmac('sha256', SERVER_SECRET).update(`${anchorId}|${chainHead}|${receivedAt}`).digest('hex');
}

export class MockAnchorServer {
  constructor() {
    this.records = [];
  }

  // POST /anchors — receives only key_id + chain head + client sig (32B相当).
  receive({ key_id, seq, chain_head }, receivedAtIso) {
    const anchor_id = 'a' + String(this.records.length + 1).padStart(4, '0');
    const record = {
      anchor_id,
      key_id,
      seq,
      chain_head,
      received_at: receivedAtIso,
      server_sig: receiptSig(anchor_id, chain_head, receivedAtIso),
    };
    this.records.push(record);
    return record;
  }
}

export function verifyReceipt({ anchor_id, chain_head, received_at, server_sig }) {
  return receiptSig(anchor_id, chain_head, received_at) === server_sig;
}
