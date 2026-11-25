'use strict';

/**
 * 账号存储
 * ---------------------------------------------------------------
 * - 只保存邮箱 + 加密后的密码（Windows DPAPI / safeStorage）；
 * - 绝不把密码明文写进文件；
 * - 支持列表、新增/更新、删除、取密码、更新最近使用时间。
 */

const fs = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');

function createAccountStore(filePath) {
  function readRaw() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(parsed?.accounts)) return parsed;
    } catch {}
    return { accounts: [], rememberPassword: true };
  }

  function writeRaw(data) {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  function encryptionAvailable() {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  function encrypt(plain) {
    if (!encryptionAvailable()) return null;
    try {
      return safeStorage.encryptString(plain).toString('base64');
    } catch {
      return null;
    }
  }

  function decrypt(cipherBase64) {
    if (!cipherBase64) return null;
    try {
      return safeStorage.decryptString(Buffer.from(cipherBase64, 'base64'));
    } catch {
      return null;
    }
  }

  /** 对外列表：不带密码 */
  function list() {
    const data = readRaw();
    return {
      rememberPassword: data.rememberPassword !== false,
      encryptionAvailable: encryptionAvailable(),
      accounts: data.accounts.map((item) => ({
        id: item.id,
        email: item.email,
        hasPassword: Boolean(item.passwordCipher),
        createdAt: item.createdAt || null,
        lastUsedAt: item.lastUsedAt || null,
      })),
    };
  }

  /** 新增或更新账号（同一邮箱视为更新） */
  function upsert({ email, password = '', rememberPassword = true }) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized) throw new Error('邮箱不能为空');

    const data = readRaw();
    const now = new Date().toISOString();

    let cipher = null;
    if (rememberPassword && password) {
      cipher = encrypt(password);
      if (!cipher) throw new Error('当前系统不支持密码加密存储，已取消保存密码');
    }

    const existing = data.accounts.find((item) => item.email.toLowerCase() === normalized);
    if (existing) {
      existing.email = String(email).trim();
      existing.updatedAt = now;
      if (rememberPassword) existing.passwordCipher = cipher;
      else existing.passwordCipher = null;
    } else {
      data.accounts.push({
        id: `acc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        email: String(email).trim(),
        passwordCipher: cipher,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
      });
    }

    writeRaw(data);
    return list();
  }

  /** 删除账号记录（本地记忆，不影响 Google 账号本身） */
  function remove(id) {
    const data = readRaw();
    data.accounts = data.accounts.filter((item) => item.id !== id);
    writeRaw(data);
    return list();
  }

  /** 取回密码明文（仅在内存中使用，用于自动填写） */
  function getPassword(id) {
    const data = readRaw();
    const account = data.accounts.find((item) => item.id === id);
    return account ? decrypt(account.passwordCipher) : null;
  }

  function getAccount(id) {
    const data = readRaw();
    const account = data.accounts.find((item) => item.id === id);
    if (!account) return null;
    return { id: account.id, email: account.email, hasPassword: Boolean(account.passwordCipher) };
  }

  function touch(id) {
    const data = readRaw();
    const account = data.accounts.find((item) => item.id === id);
    if (!account) return;
    account.lastUsedAt = new Date().toISOString();
    writeRaw(data);
  }

  function setRememberPassword(remember) {
    const data = readRaw();
    data.rememberPassword = Boolean(remember);
    if (!remember) {
      for (const account of data.accounts) account.passwordCipher = null;
    }
    writeRaw(data);
    return list();
  }

  return {
    list,
    upsert,
    remove,
    getPassword,
    getAccount,
    touch,
    setRememberPassword,
    encryptionAvailable,
    filePath,
    ensureFile() {
      if (!fs.existsSync(filePath)) writeRaw({ accounts: [], rememberPassword: true });
    },
  };
}

module.exports = { createAccountStore };
