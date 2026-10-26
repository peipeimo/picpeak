// p8 (2026-10 migration): S3 sockets leaked until the 50-socket pool was
// full and every upload hung. These pin the three fixes.
const S3StorageAdapter = require('../s3Storage');
const { S3Client, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

jest.mock('@aws-sdk/client-s3');
jest.mock('@aws-sdk/lib-storage');
jest.mock('@aws-sdk/s3-request-presigner');
jest.mock('../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const logger = require('../../../utils/logger');

// Fake only the clocks: a stream delivers 'end' on process.nextTick, which
// Jest would otherwise freeze too.
const fakeClock = () => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });

// An S3 response body the way the SDK hands it out: a readable stream on a
// socket whose bytesRead only grows while someone consumes it.
const fakeBody = () => {
  const body = new PassThrough();
  body.socket = { bytesRead: 0 };
  return body;
};

describe('S3 socket leaks (p8)', () => {
  let s3, send;

  beforeEach(() => {
    jest.clearAllMocks();
    send = jest.fn();
    S3Client.mockImplementation(() => ({ send }));
    HeadObjectCommand.mockImplementation((input) => ({ input }));
    GetObjectCommand.mockImplementation((input) => ({ input }));
    s3 = new S3StorageAdapter({ bucket: 'b', region: 'auto', retryDelay: 0 });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('S3 client configuration', () => {
    it('does not wrap GetObject bodies in a ChecksumStream that cannot be destroyed', () => {
      // A ChecksumStream Body leaks its socket when destroyed (proven
      // against R2 on 2026-10-26); WHEN_REQUIRED hands out the real response.
      expect(S3Client).toHaveBeenCalledWith(expect.objectContaining({ responseChecksumValidation: 'WHEN_REQUIRED' }));
    });
  });

  describe('abandoned response bodies', () => {
    it('destroys a body nobody reads, so its socket returns to the pool', async () => {
      fakeClock();
      s3.config.bodyIdleMs = 1000;
      const body = fakeBody();
      send.mockResolvedValue({ Body: body });

      const got = await s3.downloadStream('events/active/g/a.jpg');
      expect(got).toBe(body);
      jest.advanceTimersByTime(3000);

      expect(body.destroyed).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('abandoned'),
        expect.objectContaining({ key: 'events/active/g/a.jpg', origin: expect.stringContaining('S3 body opened here') }),
      );
    });

    it('leaves a body alone while bytes keep arriving', async () => {
      fakeClock();
      s3.config.bodyIdleMs = 1000;
      const body = fakeBody();
      send.mockResolvedValue({ Body: body });

      await s3.downloadStream('k');
      for (let i = 0; i < 10; i += 1) {
        body.socket.bytesRead += 65536; // a reader is consuming it
        jest.advanceTimersByTime(500);
      }

      expect(body.destroyed).toBe(false);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('stops watching a body once it has ended', async () => {
      fakeClock();
      s3.config.bodyIdleMs = 1000;
      const body = fakeBody();
      send.mockResolvedValue({ Body: body });

      await s3.downloadStream('k');
      const ended = new Promise((r) => body.once('end', r));
      body.resume();
      body.end('done');
      await ended;
      jest.advanceTimersByTime(5000);

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('download()', () => {
    it('destroys the body when writing the local file fails', async () => {
      const body = fakeBody();
      send
        .mockResolvedValueOnce({ ContentLength: 3 })   // HeadObject
        .mockResolvedValueOnce({ Body: body });        // GetObject
      // A directory as the target makes the write stream fail (EISDIR).
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3leak-'));

      await expect(s3.download('k', dir)).rejects.toThrow();

      expect(body.destroyed).toBe(true);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('upload() retry', () => {
    it('retries with a NEW Upload and a fresh file stream', async () => {
      const timeout = Object.assign(new Error('socket timed out'), { name: 'TimeoutError' });
      const spent = new Error('@aws-sdk/lib-storage: this instance of Upload has already executed .done(). Create a new instance.');
      const first = { on: jest.fn(), done: jest.fn().mockRejectedValueOnce(timeout).mockRejectedValue(spent) };
      const second = { on: jest.fn(), done: jest.fn().mockResolvedValue({ Location: 'ok' }) };
      Upload.mockImplementationOnce(() => first).mockImplementationOnce(() => second);
      jest.spyOn(Math, 'random').mockReturnValue(0);
      jest.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 4 });
      // Own mock: another suite in the same worker may have left
      // createReadStream returning one shared object.
      const open = jest.spyOn(fs, 'createReadStream').mockImplementation(() => new PassThrough());

      const result = await s3.upload('/tmp/p.jpg', 'events/active/g/p.jpg');

      expect(result.Location).toBe('ok');
      expect(Upload).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledTimes(2);
      const bodies = Upload.mock.calls.map((c) => c[0].params.Body);
      expect(bodies[0]).not.toBe(bodies[1]);
    });
  });
});
