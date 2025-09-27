# Ausculta

[Deployed Version](https://agusx1211.github.io/Ausculta)

Ausculta is a browser-based demo that listens to a microphone input, extracts the amplitude envelope, and detects likely heartbeat peaks in real time. It visualises both the filtered waveform and the autocorrelation used for peak picking, highlighting adult and fetal heart rate bands.

**Warning:** This project is a demonstration only and is not a medical device for diagnosis or monitoring.

## Getting Started

1. Serve the `src` directory over HTTPS or `localhost` with HTTP. Access to `getUserMedia` requires a secure context.
   - Example: `npx serve src` or `python -m http.server --directory src`.
2. Visit the served page in a modern Chromium-based browser (AudioWorklet support recommended).
3. Grant microphone access when prompted and place the microphone or stethoscope adapter close to the chest.

## Controls

- **Start/Stop**: Begin or stop microphone capture.
- **Sensitivity**: Adjust the detection threshold (lower values reduce gain, higher values increase).
- **Window**: Choose the analysis window in seconds for the autocorrelation detector.
- **Start/Stop recording**: Capture the raw microphone stream in memory for later review (requires the microphone to be active).
- **Download raw WAV**: Export the in-memory recording as a 16-bit mono WAV file without filtering or processing.
- **Upload audio…**: Load an existing audio file for offline analysis; multichannel files are downmixed to mono automatically.
- **Playback controls**: Play/pause, scrub the timeline, and toggle between the original recording and an augmented synthetic heartbeat derived from the detected BPM (if available).

## File Layout

```
src/
├── app.js       # Web Audio graph, envelope detector, peak detection, and rendering
├── index.html   # HTML scaffold
└── styles.css   # Layout and visual styling
```

## Development Notes

- The envelope is computed in an `AudioWorkletProcessor` running at 200 Hz with a short smoothing filter.
- Peak detection uses autocorrelation with harmonic suppression to identify up to three heart rates in the 40-210 BPM range.

## Deployment

- Push to `main` (or run the workflow manually) to publish `src` via the included GitHub Pages action located at `.github/workflows/deploy.yml`.
- Ensure GitHub Pages is set to "Deploy from GitHub Actions" in the repository settings; the workflow uploads only the contents of `src`.

## License

Released under the [MIT License](LICENSE).
