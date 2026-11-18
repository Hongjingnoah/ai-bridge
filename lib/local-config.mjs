// 读取本机专用配置：环境变量优先，其次是仓库根目录的 local.config.json（已被 .gitignore 排除）。
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(import.meta.dirname, '..', 'local.config.json');
let cache;

export function localConfig(key) {
  if (process.env[key]) return process.env[key];
  if (cache === undefined) {
    try {
      cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
      cache = {};
    }
  }
  return cache[key] || undefined;
}
