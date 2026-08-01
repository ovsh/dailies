Dailies now runs on Windows x64 while keeping the Apple Silicon Mac build.

WHAT IS NEW

- Windows beta installer for 64-bit Windows 10 and 11. This beta is unsigned, so Windows shows "Unknown publisher" during installation.
- Local transcription on Windows. Dailies ships whisper.cpp for Windows and keeps audio on the computer. Apple Silicon continues to use Metal.
- Windows updates. A verified NSIS download becomes ready to install without waiting for the macOS Squirrel staging event.
- Native window controls and menus on both platforms.
- Diagnostic ZIP export now uses the operating system's archive command.
- Export actions now say "Show in folder" on both platforms.

INSTALL

- Mac: download `Dailies-0.5.4-arm64.dmg`, then drag Dailies to Applications.
- Windows: download and run `Dailies-0.5.4-Setup-x64.exe`.

AUTO-UPDATE

- Existing Mac installs update through `latest-mac.yml`.
- Windows installs update through `latest.yml`.
