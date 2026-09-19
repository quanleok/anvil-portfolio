const fs = require("node:fs/promises");
const crypto = require("node:crypto");

// Atomic file write via unique-tmp + rename. Two concurrent writers to the
// same target each get their own .tmp.<random>, so neither can ENOENT the
// other's rename. The final rename is single-syscall atomic on POSIX
// filesystems. Last writer wins on the target — for read-modify-write
// sequences, callers must serialize at a higher level (see withWriteLock).
async function atomicWriteFile(targetPath, content, encoding = "utf8") {
  const tmp = `${targetPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  try {
    await fs.writeFile(tmp, content, encoding);
    await fs.rename(tmp, targetPath);
  } catch (error) {
    try { await fs.rm(tmp, { force: true }); } catch {}
    throw error;
  }
}

// Per-key in-process promise queue. Each call chains onto the previous
// pending promise for the same key, so read-modify-write sequences against
// the same resource serialize. Failures don't poison the chain.
const locks = new Map();

function withWriteLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  const next = previous.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

module.exports = { atomicWriteFile, withWriteLock };
