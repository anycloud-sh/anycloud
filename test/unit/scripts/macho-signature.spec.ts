import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  fitMachOSignature,
  verifyMachOSignature,
} from '../../../scripts/macho-signature.js';

const PAGE = 4096;
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest();

// A minimal arm64 executable with one LC_CODE_SIGNATURE and an ad-hoc
// SuperBlob (CodeDirectory plus empty requirements), hashed as macOS expects
// unless `padLastPage` reproduces Bun 1.3.3's zero-padded last page.
function signedMachO({
  codeLength = 2 * PAGE + 0x340,
  padLastPage = false,
} = {}): Buffer {
  const code = Buffer.alloc(codeLength, 0xab);
  code.writeUInt32LE(0xfeedfacf, 0);
  code.writeUInt32LE(0x0100000c, 4);
  code.writeUInt32LE(2, 12);
  code.writeUInt32LE(1, 16);
  code.writeUInt32LE(16, 20);
  code.writeUInt32LE(0x1d, 32);
  code.writeUInt32LE(16, 36);
  code.writeUInt32LE(codeLength, 40);

  const requirements = Buffer.alloc(12);
  requirements.writeUInt32BE(0xfade0c01, 0);
  requirements.writeUInt32BE(12, 4);
  const identifier = Buffer.from('test\0');
  const pages = Math.ceil(codeLength / PAGE);
  // The load command's datasize is signed code, so it is set before hashing.
  code.writeUInt32LE(
    28 + 44 + identifier.length + (2 + pages) * 32 + requirements.length,
    44,
  );
  // Special slots run backwards from the code hashes: -2 requirements, -1 Info.plist.
  const hashes = [sha256(requirements), Buffer.alloc(32)];
  for (let page = 0; page < pages; page++) {
    const data = code.subarray(
      page * PAGE,
      Math.min((page + 1) * PAGE, codeLength),
    );
    hashes.push(
      sha256(
        padLastPage
          ? Buffer.concat([data, Buffer.alloc(PAGE - data.length)])
          : data,
      ),
    );
  }
  const header = Buffer.alloc(44);
  const codeDirectory = Buffer.concat([header, identifier, ...hashes]);
  header.writeUInt32BE(0xfade0c02, 0);
  header.writeUInt32BE(codeDirectory.length, 4);
  header.writeUInt32BE(0x20400, 8);
  header.writeUInt32BE(0x2, 12);
  header.writeUInt32BE(44 + identifier.length + 2 * 32, 16);
  header.writeUInt32BE(44, 20);
  header.writeUInt32BE(2, 24);
  header.writeUInt32BE(pages, 28);
  header.writeUInt32BE(codeLength, 32);
  header.writeUInt8(32, 36);
  header.writeUInt8(2, 37);
  header.writeUInt8(12, 39);
  codeDirectory.set(header);

  const index = Buffer.alloc(28);
  index.writeUInt32BE(0xfade0cc0, 0);
  index.writeUInt32BE(28 + codeDirectory.length + requirements.length, 4);
  index.writeUInt32BE(2, 8);
  index.writeUInt32BE(0, 12);
  index.writeUInt32BE(28, 16);
  index.writeUInt32BE(2, 20);
  index.writeUInt32BE(28 + codeDirectory.length, 24);
  return Buffer.concat([code, index, codeDirectory, requirements]);
}

describe('verifyMachOSignature', () => {
  it('accepts a signature hashed the way macOS checks it', () => {
    expect(verifyMachOSignature(signedMachO())).toEqual({
      identifier: 'test',
      pages: 3,
    });
    expect(
      verifyMachOSignature(signedMachO({ codeLength: 2 * PAGE })).pages,
    ).toBe(2);
  });

  it('rejects a last page hashed zero-padded, as Bun 1.3.3 signs darwin-arm64', () => {
    expect(() =>
      verifyMachOSignature(signedMachO({ padLastPage: true })),
    ).toThrow('page 2 hash does not match');
  });

  it('rejects code changed after signing', () => {
    const binary = signedMachO();
    binary[PAGE + 1] ^= 1;
    expect(() => verifyMachOSignature(binary)).toThrow(
      'page 1 hash does not match',
    );
  });

  it('rejects a hash size that is not the digest length, even with code changed', () => {
    const binary = signedMachO();
    binary[100] ^= 1;
    binary[2 * PAGE + 0x340 + 28 + 36] = 0;
    expect(() => verifyMachOSignature(binary)).toThrow(
      'CodeDirectory hash size 0 is not 32 for sha256',
    );
  });

  it('rejects a signature carrying an alternate CodeDirectory it does not verify', () => {
    const binary = signedMachO();
    binary.writeUInt32BE(0x1000, 2 * PAGE + 0x340 + 20);
    expect(() => verifyMachOSignature(binary)).toThrow(
      'alternate CodeDirectory 1000 is not verified',
    );
  });

  it('rejects a requirements blob that does not match its special slot', () => {
    const binary = signedMachO();
    binary[binary.length - 1] ^= 1;
    expect(() => verifyMachOSignature(binary)).toThrow(
      'special slot 2 hash does not match its blob',
    );
  });

  it('rejects bytes after the signature and a signature past the end of the file', () => {
    expect(() =>
      verifyMachOSignature(Buffer.concat([signedMachO(), Buffer.alloc(8)])),
    ).toThrow('signature ends at');
    expect(() => verifyMachOSignature(signedMachO().subarray(0, -8))).toThrow(
      'signature ends at',
    );
  });
});

describe('fitMachOSignature', () => {
  it('shrinks a signature size that runs past the end of the file and leaves a fitting one alone', () => {
    const truncated = Buffer.from(signedMachO().subarray(0, -8));
    expect(fitMachOSignature(truncated)).toBe(true);
    expect(
      truncated.readUInt32LE(32 + 12) + truncated.readUInt32LE(32 + 8),
    ).toBe(truncated.length);
    expect(fitMachOSignature(signedMachO())).toBe(false);
  });
});
