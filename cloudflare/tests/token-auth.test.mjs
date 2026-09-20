import assert from "node:assert/strict";
import { sha256LowerHex } from "../src/auth.js";

assert.equal(await sha256LowerHex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
assert.equal(await sha256LowerHex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
assert.equal(await sha256LowerHex(" A-_9 "), "03057f1843c7b1f2594a51eca96cfd42470f46eac622023d71a0fe18c876a380");
console.log("token auth fixtures passed");
