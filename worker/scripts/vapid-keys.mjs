#!/usr/bin/env node
// Prints a new Web Push (VAPID) keypair for hdctl, and the Vault command that
// stores it where the deploy reads it (kv/github/hdctl/push).
//
//   npm run vapid-keys -w worker
//
// Run it once. Every browser subscription is bound to the public key it
// subscribed with, so a new keypair silently stops pushes to every device
// that already turned notifications on: each would have to turn them off and
// on again. Keep the pair in Vault and don't regenerate it unless it leaked.

const b64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
const privateKey = d.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log("");
console.log("Store them (the deploy syncs them to the Worker):");
console.log(`  vault kv put kv/github/hdctl/push VAPID_PUBLIC_KEY=${publicKey} VAPID_PRIVATE_KEY=<the private key above>`);
