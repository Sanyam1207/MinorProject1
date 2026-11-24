import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const modelsDirectory = path.resolve(process.cwd(), "models");
const models = [
  {
    name: "streaming English ASR",
    directory: "sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06",
    archive: "sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06.tar.bz2",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06.tar.bz2",
    required: ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
  },
  {
    name: "Kokoro English TTS",
    directory: "kokoro-en-v0_19",
    archive: "kokoro-en-v0_19.tar.bz2",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2",
    required: ["model.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"],
  },
];

const installed = (model) => model.required.every((entry) => existsSync(path.join(modelsDirectory, model.directory, entry)));

const download = async (model, destination) => {
  console.log(`Downloading ${model.name}...`);
  const response = await fetch(model.url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${model.url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
};

await mkdir(modelsDirectory, { recursive: true });
for (const model of models) {
  if (installed(model)) {
    console.log(`${model.name} is already installed.`);
    continue;
  }

  const archivePath = path.join(modelsDirectory, model.archive);
  try {
    if (!existsSync(archivePath)) await download(model, archivePath);
    console.log(`Extracting ${model.name}...`);
    const extraction = spawnSync("tar", ["-xf", archivePath, "-C", modelsDirectory], { stdio: "inherit" });
    if (extraction.status !== 0) throw new Error("tar extraction failed. Install a tar-compatible extractor and rerun the command.");
    if (!installed(model)) throw new Error(`${model.name} archive did not contain the expected files.`);
    await rm(archivePath, { force: true });
    console.log(`${model.name} installed.`);
  } catch (error) {
    console.error(`Unable to install ${model.name}: ${error.message}`);
    process.exitCode = 1;
    break;
  }
}
