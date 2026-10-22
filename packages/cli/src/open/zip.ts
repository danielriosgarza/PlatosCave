import { crc32, deflateRawSync } from 'node:zlib';

/** One file of an archive: its path inside it, with `/` between folders, and its bytes. */
export type ZipEntry = { path: string; bytes: Uint8Array };

/**
 * A zip archive of `entries`, in their order, each deflated. Every entry has the same time
 * (1980-01-01, the format's first), so the same files give the same bytes and so the same object
 * name in every build. Names are UTF-8 (flag bit 11). No entry, archive or field passes the
 * 32-bit limits: the files of one notebook are at most 100 of 25 MB (`MAX_DATA_FILES`).
 */
export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { path, bytes } of entries) {
    const name = Buffer.from(path, 'utf8');
    const data = deflateRawSync(bytes);
    const fields = (header: Buffer, at: number) => {
      header.writeUInt16LE(0x0800, at); // UTF-8 names
      header.writeUInt16LE(8, at + 2); // deflate
      header.writeUInt16LE(0, at + 4); // time 00:00
      header.writeUInt16LE(0x21, at + 6); // date 1980-01-01
      header.writeUInt32LE(crc32(bytes), at + 8);
      header.writeUInt32LE(data.length, at + 12);
      header.writeUInt32LE(bytes.length, at + 16);
      header.writeUInt16LE(name.length, at + 20);
    };
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    fields(head, 6);
    local.push(head, name, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    fields(entry, 8);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += head.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
}
