import { mkdir, readdir, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Deliberate allowlist: the static publish directory must never contain data/,
// env files, Git metadata, or symlinks which can point outside the media tree.
export async function copyStaticMedia(source, destination) {
  for (const [folder, extension] of [
    ['img', '.jpg'],
    ['gif', '.gif']
  ]) {
    const files = await readdir(path.join(source, folder), { withFileTypes: true })
    const media = files.filter(
      (file) => file.isFile() && path.extname(file.name).toLowerCase() === extension
    )
    if (!media.length) throw new Error('Missing exercise media in ' + folder)
    await mkdir(path.join(destination, folder), { recursive: true })
    await Promise.all(
      media.map((file) =>
        copyFile(path.join(source, folder, file.name), path.join(destination, folder, file.name))
      )
    )
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = fileURLToPath(new URL('../', import.meta.url))
  await copyStaticMedia(path.join(repo, 'media'), path.join(repo, 'frontend/dist'))
}
