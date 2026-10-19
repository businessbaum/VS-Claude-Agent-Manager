'use strict';

const fs = require('fs');

const MAX_PARTIAL = 8 * 1024 * 1024;

/**
 * Reads an append-only JSONL file incrementally: every call returns only the
 * complete lines written since the previous call.
 *
 * Bytes are kept, not characters — a writer can flush halfway through a
 * multi-byte character, and decoding that boundary eagerly would corrupt the
 * line.  The remainder is carried until its newline arrives.
 */
class Tailer {
  /**
   * @param {string} file
   * @param {number} [startAt] byte offset to begin at; defaults to the start of
   *   the file.  Pass a nonzero value to skip a large history you do not need.
   */
  constructor(file, startAt = 0) {
    this.file = file;
    this.offset = startAt;
    this.partial = Buffer.alloc(0);
    // Set by read() when it had to start over.  A caller that keeps running
    // totals has to throw them away, or it folds the replayed history into
    // figures it has already counted once.
    this.rewound = false;
  }

  /** @returns {string[]} complete lines appended since the last read. */
  read() {
    this.rewound = false;
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      return [];
    }

    // Truncated or replaced underneath us — start over rather than emit garbage.
    // A file recreated at a different size lands here; one recreated at exactly
    // the same size is indistinguishable from an untouched file and is missed.
    if (st.size < this.offset) {
      this.offset = 0;
      this.partial = Buffer.alloc(0);
      this.rewound = true;
    }
    if (st.size === this.offset) return [];

    const length = st.size - this.offset;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      read = fs.readSync(fd, buf, 0, length, this.offset);
    } catch {
      return [];
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* already gone */
        }
      }
    }
    this.offset += read;

    const all = this.partial.length ? Buffer.concat([this.partial, buf.subarray(0, read)]) : buf.subarray(0, read);
    const lastNewline = all.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      // A single line longer than everything buffered so far. Keep it unless it
      // has grown implausibly large, in which case drop it and resync.
      this.partial = all.length > MAX_PARTIAL ? Buffer.alloc(0) : all;
      return [];
    }
    this.partial = Buffer.from(all.subarray(lastNewline + 1));
    return all.subarray(0, lastNewline).toString('utf8').split('\n');
  }
}

/**
 * Reads the first `bytes` of a file as text. Used to find a transcript's first
 * record without parsing the whole thing.
 */
function readHead(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    const length = Math.min(bytes, st.size);
    const buf = Buffer.allocUnsafe(length);
    const read = fs.readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Reads the last `bytes` of a file, dropping the leading fragment so every
 * returned line is complete.
 */
function readTailLines(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    const length = Math.min(bytes, st.size);
    const start = st.size - length;
    const buf = Buffer.allocUnsafe(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    let slice = buf.subarray(0, read);
    if (start > 0) {
      const firstNewline = slice.indexOf(0x0a);
      if (firstNewline === -1) return [];
      slice = slice.subarray(firstNewline + 1);
    }
    return slice
      .toString('utf8')
      .split('\n')
      .filter((l) => l.length > 0);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = { Tailer, readHead, readTailLines };
