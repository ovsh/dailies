Indexing is much faster on the same Mac.

WHAT IS NEW

- Parallel pipeline. Dailies ran 2 indexing jobs at one time. Now it runs up to 8, scaled to your Mac's core count. Two cores always stay free for the interface and the system.
- Two transcriptions at one time. Whisper runs on the GPU. Two instances share it. More than two do not help, so the limit is two.
- Automatic back-off. Dailies watches the system load while it indexes. If the load stays high, it starts fewer jobs. When the load falls, it steps back up. Running jobs are never stopped. If the system runs out of file handles, Dailies steps down at once and recovers the same way.
- Faster speech model. The default model becomes large-v3-turbo-q8_0. It is the same model, stored with smaller numbers. It is 30-60% faster and the download is 0.9 GB instead of 1.6 GB. The accuracy change is too small to measure in normal use.
- No stall on update. An install that has the old model file keeps transcribing with it. The new model is a choice in Settings, not a requirement.
- Each change to the job limit is written to the log, with the reason.

AUTO-UPDATE

- Installed versions 0.4.x and 0.5.x update automatically.
- An app that runs from the DMG does not update. Move it to /Applications.
