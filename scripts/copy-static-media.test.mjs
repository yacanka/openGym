import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { copyStaticMedia } from './copy-static-media.mjs'

test('static package copies only known media files, never data or symlinks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'opengym-media-test-'))
  try {
    const source = path.join(root, 'media'),
      out = path.join(root, 'dist')
    await mkdir(path.join(source, 'img'), { recursive: true })
    await mkdir(path.join(source, 'gif'))
    await writeFile(path.join(source, 'img', 'exercise.jpg'), 'image')
    await writeFile(path.join(source, 'gif', 'exercise.gif'), 'animation')
    await writeFile(path.join(source, 'img', 'private.json'), 'not public')
    await symlink(path.join(source, 'img', 'private.json'), path.join(source, 'img', 'link.jpg'))
    await copyStaticMedia(source, out)
    assert.deepEqual(await readdir(path.join(out, 'img')), ['exercise.jpg'])
    assert.equal(await readFile(path.join(out, 'gif', 'exercise.gif'), 'utf8'), 'animation')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
