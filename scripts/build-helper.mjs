// Build the resident helper and stage it inside the npm package directory.
//
// Source lives in src/DshToastQuestion; every generated file goes under
// artifacts/ (configured by Directory.Build.props). Only the published exe is
// copied into lib/, because that is the directory npm ships and the host
// resolves at runtime.
import { spawn } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const project = join(root, 'src', 'DshToastQuestion', 'DshToastQuestion.csproj')
const publishDir = join(root, 'artifacts', 'publish')
const destination = join(root, 'lib', 'dsh-toast-question.exe')
const dotnet = process.env.DOTNET ?? 'dotnet'

const args = [
  'publish',
  project,
  '-c', 'Release',
  '-r', 'win-x64',
  '--self-contained', 'false',
  '-p:PublishSingleFile=true',
  '-o', publishDir,
  '--nologo',
]

await new Promise((resolve, reject) => {
  const child = spawn(dotnet, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  child.once('error', (error) => {
    reject(new Error(`cannot run '${dotnet}': ${error.message}. Install the .NET 10 SDK or set DOTNET to its path.`))
  })
  child.once('exit', (code) => {
    if (code === 0) resolve()
    else reject(new Error(`dotnet publish exited ${code}`))
  })
})

await mkdir(dirname(destination), { recursive: true })
await copyFile(join(publishDir, 'dsh-toast-question.exe'), destination)
console.log(`helper built: ${publishDir}`)
console.log(`helper staged: ${destination}`)
