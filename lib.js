"use strict";
const crypto = require("crypto");

function genId(prefix) { return prefix + "_" + crypto.randomBytes(9).toString("hex"); }

function genPin() {
  const seg = () => String(crypto.randomInt(0, 10000)).padStart(4, "0");
  return `${seg()}-${seg()}-${seg()}-${seg()}`;
}

function genSerial() {
  return "SN" + String(crypto.randomInt(0, 1e9)).padStart(9, "0") + String(crypto.randomInt(0, 999)).padStart(3, "0");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  // timing-safe compare so a mistyped password can't be brute-forced faster
  // by measuring how quickly the server rejects it
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
}

function unitPrice(denom) { return Math.round(denom * 0.97); }

module.exports = { genId, genPin, genSerial, hashPassword, verifyPassword, unitPrice };
