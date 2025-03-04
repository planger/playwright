/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { expect, contextTest as test, browserTest } from './config/browserTest';
import { ZipFileSystem } from 'playwright-core/lib/utils/vfs';
import jpeg from 'jpeg-js';

test.skip(({ trace }) => !!trace);

test('should collect trace with resources, but no js', async ({ context, page, server }, testInfo) => {
  await context.tracing.start({ screenshots: true, snapshots: true });
  await page.goto(server.PREFIX + '/frames/frame.html');
  await page.setContent('<button>Click</button>');
  await page.click('"Click"');
  await page.mouse.move(20, 20);
  await page.mouse.dblclick(30, 30);
  await page.keyboard.insertText('abc');
  await page.waitForTimeout(2000);  // Give it some time to produce screenshots.
  await page.close();
  await context.tracing.stop({ path: testInfo.outputPath('trace.zip') });

  const { events } = await parseTrace(testInfo.outputPath('trace.zip'));
  expect(events[0].type).toBe('context-options');
  expect(events.find(e => e.metadata?.apiName === 'page.goto')).toBeTruthy();
  expect(events.find(e => e.metadata?.apiName === 'page.setContent')).toBeTruthy();
  expect(events.find(e => e.metadata?.apiName === 'page.click')).toBeTruthy();
  expect(events.find(e => e.metadata?.apiName === 'mouse.move')).toBeTruthy();
  expect(events.find(e => e.metadata?.apiName === 'mouse.dblclick')).toBeTruthy();
  expect(events.find(e => e.metadata?.apiName === 'keyboard.insertText')).toBeTruthy();
  expect(events.find(e => e.metadata?.apiName === 'page.close')).toBeTruthy();

  expect(events.some(e => e.type === 'frame-snapshot')).toBeTruthy();
  expect(events.some(e => e.type === 'screencast-frame')).toBeTruthy();
  const style = events.find(e => e.type === 'resource-snapshot' && e.snapshot.request.url.endsWith('style.css'));
  expect(style).toBeTruthy();
  expect(style.snapshot.response.content._sha1).toBeTruthy();
  const script = events.find(e => e.type === 'resource-snapshot' && e.snapshot.request.url.endsWith('script.js'));
  expect(script).toBeTruthy();
  expect(script.snapshot.response.content._sha1).toBe(undefined);
});

test('should not collect snapshots by default', async ({ context, page, server }, testInfo) => {
  await context.tracing.start();
  await page.goto(server.EMPTY_PAGE);
  await page.setContent('<button>Click</button>');
  await page.click('"Click"');
  await page.close();
  await context.tracing.stop({ path: testInfo.outputPath('trace.zip') });

  const { events } = await parseTrace(testInfo.outputPath('trace.zip'));
  expect(events.some(e => e.type === 'frame-snapshot')).toBeFalsy();
  expect(events.some(e => e.type === 'resource-snapshot')).toBeFalsy();
});

test('should exclude internal pages', async ({ browserName, context, page, server }, testInfo) => {
  test.fixme(true, 'https://github.com/microsoft/playwright/issues/6743');
  await page.goto(server.EMPTY_PAGE);

  await context.tracing.start();
  await context.storageState();
  await page.close();
  await context.tracing.stop({ path: testInfo.outputPath('trace.zip') });

  const trace = await parseTrace(testInfo.outputPath('trace.zip'));
  const pageIds = new Set();
  trace.events.forEach(e => {
    const pageId = e.metadata?.pageId;
    if (pageId)
      pageIds.add(pageId);
  });
  expect(pageIds.size).toBe(1);
});

test('should collect two traces', async ({ context, page, server }, testInfo) => {
  await context.tracing.start({ screenshots: true, snapshots: true });
  await page.goto(server.EMPTY_PAGE);
  await page.setContent('<button>Click</button>');
  await page.click('"Click"');
  await context.tracing.stop({ path: testInfo.outputPath('trace1.zip') });

  await context.tracing.start({ screenshots: true, snapshots: true });
  await page.dblclick('"Click"');
  await page.close();
  await context.tracing.stop({ path: testInfo.outputPath('trace2.zip') });

  {
    const { events } = await parseTrace(testInfo.outputPath('trace1.zip'));
    expect(events[0].type).toBe('context-options');
    expect(events.find(e => e.metadata?.apiName === 'page.goto')).toBeTruthy();
    expect(events.find(e => e.metadata?.apiName === 'page.setContent')).toBeTruthy();
    expect(events.find(e => e.metadata?.apiName === 'page.click')).toBeTruthy();
    expect(events.find(e => e.metadata?.apiName === 'page.dblclick')).toBeFalsy();
    expect(events.find(e => e.metadata?.apiName === 'page.close')).toBeFalsy();
  }

  {
    const { events } = await parseTrace(testInfo.outputPath('trace2.zip'));
    expect(events[0].type).toBe('context-options');
    expect(events.find(e => e.metadata?.apiName === 'page.goto')).toBeFalsy();
    expect(events.find(e => e.metadata?.apiName === 'page.setContent')).toBeFalsy();
    expect(events.find(e => e.metadata?.apiName === 'page.click')).toBeFalsy();
    expect(events.find(e => e.metadata?.apiName === 'page.dblclick')).toBeTruthy();
    expect(events.find(e => e.metadata?.apiName === 'page.close')).toBeTruthy();
  }
});

test('should not stall on dialogs', async ({ page, context, server }) => {
  await context.tracing.start({ screenshots: true, snapshots: true });
  await page.goto(server.EMPTY_PAGE);

  page.on('dialog', async dialog => {
    await dialog.accept();
  });

  await page.evaluate(() => {
    confirm('are you sure');
  });
  await context.tracing.stop();
});


for (const params of [
  {
    id: 'fit',
    width: 500,
    height: 500,
  },
  {
    id: 'crop',
    width: 400, // Less than 450 to test firefox
    height: 800,
  },
  {
    id: 'scale',
    width: 1024,
    height: 768,
  }
]) {
  browserTest(`should produce screencast frames ${params.id}`, async ({ video, contextFactory, browserName, platform, headless }, testInfo) => {
    browserTest.fixme(browserName === 'chromium' && video, 'Same screencast resolution conflicts');
    browserTest.fixme(browserName === 'chromium' && !headless, 'Chromium screencast on headed has a min width issue');
    browserTest.fixme(params.id === 'fit' && browserName === 'chromium' && platform === 'darwin', 'High DPI maxes image at 600x600');
    browserTest.fixme(params.id === 'fit' && browserName === 'webkit' && platform === 'linux', 'Image size is flaky');

    const scale = Math.min(800 / params.width, 600 / params.height, 1);
    const previewWidth = params.width * scale;
    const previewHeight = params.height * scale;

    const context = await contextFactory({ viewport: { width: params.width, height: params.height } });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    // Make sure we have a chance to paint.
    for (let i = 0; i < 10; ++i) {
      await page.setContent('<body style="box-sizing: border-box; width: 100%; height: 100%; margin:0; background: red; border: 50px solid blue"></body>');
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await context.tracing.stop({ path: testInfo.outputPath('trace.zip') });

    const { events, resources } = await parseTrace(testInfo.outputPath('trace.zip'));
    const frames = events.filter(e => e.type === 'screencast-frame');

    // Check all frame sizes.
    for (const frame of frames) {
      expect(frame.width).toBe(params.width);
      expect(frame.height).toBe(params.height);
      const buffer = resources.get('resources/' + frame.sha1);
      const image = jpeg.decode(buffer);
      expect(image.width).toBe(previewWidth);
      expect(image.height).toBe(previewHeight);
    }

    const frame = frames[frames.length - 1]; // pick last frame.
    const buffer = resources.get('resources/' + frame.sha1);
    const image = jpeg.decode(buffer);
    expect(image.data.byteLength).toBe(previewWidth * previewHeight * 4);
    expectRed(image.data, previewWidth * previewHeight * 4 / 2 + previewWidth * 4 / 2); // center is red
    expectBlue(image.data, previewWidth * 5 * 4 + previewWidth * 4 / 2); // top
    expectBlue(image.data, previewWidth * (previewHeight - 5) * 4 + previewWidth * 4 / 2); // bottom
    expectBlue(image.data, previewWidth * previewHeight * 4 / 2 + 5 * 4); // left
    expectBlue(image.data, previewWidth * previewHeight * 4 / 2 + (previewWidth - 5) * 4); // right
  });
}

test('should include interrupted actions', async ({ context, page, server }, testInfo) => {
  await context.tracing.start({ screenshots: true, snapshots: true });
  await page.goto(server.EMPTY_PAGE);
  await page.setContent('<button>Click</button>');
  page.click('"ClickNoButton"').catch(() =>  {});
  await context.tracing.stop({ path: testInfo.outputPath('trace.zip') });
  await context.close();

  const { events } = await parseTrace(testInfo.outputPath('trace.zip'));
  const clickEvent = events.find(e => e.metadata?.apiName === 'page.click');
  expect(clickEvent).toBeTruthy();
  expect(clickEvent.metadata.error.error.message).toBe('Action was interrupted');
});

test('should throw when starting with different options', async ({ context }) => {
  await context.tracing.start({ screenshots: true, snapshots: true });
  const error = await context.tracing.start({ screenshots: false, snapshots: false }).catch(e => e);
  expect(error.message).toContain('Tracing has been already started with different options');
});

test('should throw when stopping without start', async ({ context }, testInfo) => {
  const error = await context.tracing.stop({ path: testInfo.outputPath('trace.zip') }).catch(e => e);
  expect(error.message).toContain('Must start tracing before stopping');
});

test('should not throw when stopping without start but not exporting', async ({ context }, testInfo) => {
  await context.tracing.stop();
});

test('should work with multiple chunks', async ({ context, page, server }, testInfo) => {
  await context.tracing.start({ screenshots: true, snapshots: true });
  await page.goto(server.PREFIX + '/frames/frame.html');

  await context.tracing.startChunk();
  await page.setContent('<button>Click</button>');
  await page.click('"Click"');
  page.click('"ClickNoButton"').catch(() =>  {});
  await context.tracing.stopChunk({ path: testInfo.outputPath('trace.zip') });

  await context.tracing.startChunk();
  await page.hover('"Click"');
  await context.tracing.stopChunk({ path: testInfo.outputPath('trace2.zip') });

  await context.tracing.startChunk();
  await page.click('"Click"');
  await context.tracing.stopChunk();  // Should stop without a path.

  const trace1 = await parseTrace(testInfo.outputPath('trace.zip'));
  expect(trace1.events[0].type).toBe('context-options');
  expect(trace1.events.find(e => e.metadata?.apiName === 'page.goto')).toBeFalsy();
  expect(trace1.events.find(e => e.metadata?.apiName === 'page.setContent')).toBeTruthy();
  expect(trace1.events.find(e => e.metadata?.apiName === 'page.click' && !!e.metadata.error)).toBeTruthy();
  expect(trace1.events.find(e => e.metadata?.apiName === 'page.hover')).toBeFalsy();
  expect(trace1.events.find(e => e.metadata?.apiName === 'page.click' && e.metadata?.error?.error?.message === 'Action was interrupted')).toBeTruthy();
  expect(trace1.events.some(e => e.type === 'frame-snapshot')).toBeTruthy();
  expect(trace1.events.some(e => e.type === 'resource-snapshot' && e.snapshot.request.url.endsWith('style.css'))).toBeTruthy();

  const trace2 = await parseTrace(testInfo.outputPath('trace2.zip'));
  expect(trace2.events[0].type).toBe('context-options');
  expect(trace2.events.find(e => e.metadata?.apiName === 'page.goto')).toBeFalsy();
  expect(trace2.events.find(e => e.metadata?.apiName === 'page.setContent')).toBeFalsy();
  expect(trace2.events.find(e => e.metadata?.apiName === 'page.click')).toBeFalsy();
  expect(trace2.events.find(e => e.metadata?.apiName === 'page.hover')).toBeTruthy();
  expect(trace2.events.some(e => e.type === 'frame-snapshot')).toBeTruthy();
  expect(trace2.events.some(e => e.type === 'resource-snapshot' && e.snapshot.request.url.endsWith('style.css'))).toBeTruthy();
});

test('should export trace concurrently to second navigation', async ({ context, page, server }, testInfo) => {
  for (let timeout = 0; timeout < 200; timeout += 20) {
    await context.tracing.start({ screenshots: true, snapshots: true });
    await page.goto(server.PREFIX + '/grid.html');

    // Navigate to the same page to produce the same trace resources
    // that might be concurrently exported.
    const promise = page.goto(server.PREFIX + '/grid.html');
    await page.waitForTimeout(timeout);
    await Promise.all([
      promise,
      context.tracing.stop({ path: testInfo.outputPath('trace.zip') }),
    ]);
  }
});

test('should not hang for clicks that open dialogs', async ({ context, page }) => {
  await context.tracing.start({ screenshots: true, snapshots: true });
  const dialogPromise = page.waitForEvent('dialog');
  await page.setContent(`<div onclick='window.alert(123)'>Click me</div>`);
  await page.click('div', { timeout: 2000 }).catch(() => {});
  const dialog = await dialogPromise;
  await dialog.dismiss();
  await context.tracing.stop();
});

async function parseTrace(file: string): Promise<{ events: any[], resources: Map<string, Buffer> }> {
  const zipFS = new ZipFileSystem(file);
  const resources = new Map<string, Buffer>();
  for (const entry of await zipFS.entries())
    resources.set(entry, await zipFS.read(entry));
  zipFS.close();

  const events = [];
  for (const line of resources.get('trace.trace').toString().split('\n')) {
    if (line)
      events.push(JSON.parse(line));
  }
  for (const line of resources.get('trace.network').toString().split('\n')) {
    if (line)
      events.push(JSON.parse(line));
  }
  return {
    events,
    resources,
  };
}

function expectRed(pixels: Buffer, offset: number) {
  const r = pixels.readUInt8(offset);
  const g = pixels.readUInt8(offset + 1);
  const b = pixels.readUInt8(offset + 2);
  const a = pixels.readUInt8(offset + 3);
  expect(r).toBeGreaterThan(200);
  expect(g).toBeLessThan(70);
  expect(b).toBeLessThan(70);
  expect(a).toBe(255);
}

function expectBlue(pixels: Buffer, offset: number) {
  const r = pixels.readUInt8(offset);
  const g = pixels.readUInt8(offset + 1);
  const b = pixels.readUInt8(offset + 2);
  const a = pixels.readUInt8(offset + 3);
  expect(r).toBeLessThan(70);
  expect(g).toBeLessThan(70);
  expect(b).toBeGreaterThan(200);
  expect(a).toBe(255);
}
