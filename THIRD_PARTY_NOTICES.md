# Third-party notices

SnAgentsOS includes text and code adapted from the third-party projects listed
below. Every source file that ports or adapts code from one of them starts with
a one-line header naming the project, its license and the original path, for
example:

```
// Adaptado de stablyai/orca (MIT) - src/main/agent-awake-service.ts
// Adaptado de paperclipai/paperclip (MIT) - packages/adapters/claude-local/src/server/parse.ts
```

Ideas, patterns and constants taken without copying code carry no header. The
npm dependencies keep their own license files inside `node_modules`.

## stablyai/orca

- Source: https://github.com/stablyai/orca
- License: MIT
- Used in: `docs/STYLEGUIDE.md` (sections 2, 5 and 6 adapt its `docs/STYLEGUIDE.md`)
  and every file with the `stablyai/orca` header above.

```
MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## paperclipai/paperclip

- Source: https://github.com/paperclipai/paperclip
- License: MIT
- Used in: the Teams run parsers (app 2.7.0), `src/main/teams/parsers/claudeStream.ts`
  and `src/main/teams/parsers/codexExec.ts`, and every file with the
  `paperclipai/paperclip` header above.

```
MIT License

Copyright (c) 2025 Paperclip AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

# Components downloaded at runtime (desktop dictation)

Local dictation (app 2.5.0) runs a speech engine that is not part of the
installer. Nothing below is bundled with SnAgentsOS: each file is downloaded
only when the user installs a dictation pack in Settings > Terminal > Dictation,
from the official URLs pinned in `src/main/dictation/whisper/catalog.ts`
(GitHub releases of ggml-org/whisper.cpp and Hugging Face repositories at a
fixed revision), checked against its SHA-256 and stored under the app's data
folder (`whisper/`). Deleting a pack in Settings removes its files.

## whisper.cpp

- Source: https://github.com/ggml-org/whisper.cpp
- License: MIT
- Used as: the official Windows x64 release build b5454
  (`whisper-bin-x64.zip` and `whisper-bin-win-cuda-12.4.0-x64.zip`), from which
  only `whisper-server.exe`, `whisper.dll`, `ggml.dll`, `ggml-base.dll`, the
  `ggml-cpu-*.dll` variants and, for the GPU pack, `ggml-cuda.dll` are
  extracted. It runs as a separate local process bound to 127.0.0.1.

```
MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## OpenAI Whisper model weights

- Source: https://github.com/openai/whisper (weights), in the ggml conversions
  published at https://huggingface.co/ggerganov/whisper.cpp
- License: MIT
- Used as: `ggml-small-q5_1.bin` (CPU pack) and `ggml-large-v3-turbo-q8_0.bin`
  (GPU pack).

```
MIT License

Copyright (c) 2022 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Silero VAD

- Source: https://github.com/snakers4/silero-vad, in the ggml conversion
  published at https://huggingface.co/ggml-org/whisper-vad
- License: MIT
- Used as: `ggml-silero-v5.1.2.bin` (both packs), the speech gate the engine
  applies to every request.

```
MIT License

Copyright (c) 2020-present Silero Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## NVIDIA CUDA runtime and cuBLAS

- Source: NVIDIA CUDA Toolkit 12.4 redistributable components, shipped by the
  whisper.cpp project inside `whisper-bin-win-cuda-12.4.0-x64.zip`
- License: NVIDIA CUDA Toolkit End User License Agreement
  (https://docs.nvidia.com/cuda/eula/), redistributable components
- Used as: `cudart64_12.dll`, `cublas64_12.dll` and `cublasLt64_12.dll`, only in
  the GPU pack. The NVIDIA display driver (`nvcuda.dll`) comes from the user's
  own driver install and is never downloaded.
