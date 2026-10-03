import { streamUrl } from './streamUrl';

describe('streamUrl', () => {
  test('builds the Watch playlist URL with the parameters in order', () => {
    expect(streamUrl('1234ABCD', 'play.m3u', { ch: 551000000, program: 3, name: 'KABC 7.1' })).toBe(
      '/api/devices/1234ABCD/stream/play.m3u?ch=551000000&program=3&name=KABC%207.1'
    );
  });

  test('builds the Copy Stream URL request', () => {
    expect(streamUrl('1234ABCD', 'url', { ch: '605028615', program: 1 })).toBe(
      '/api/devices/1234ABCD/stream/url?ch=605028615&program=1'
    );
  });

  test('encodes the device id and values that contain reserved characters', () => {
    expect(streamUrl('a/b?c', 'url', { ch: '1&x=2', program: '3#4' })).toBe(
      '/api/devices/a%2Fb%3Fc/stream/url?ch=1%26x%3D2&program=3%234'
    );
  });
});
