# Bundled fonts

`Roboto-Regular.ttf` must be present in this directory for the caption and
text-to-video features to work. Download it from:

  https://fonts.google.com/specimen/Roboto

Then copy `Roboto-Regular.ttf` into `app/src/main/assets/`.

The app copies the font to internal storage on first launch and passes the
absolute path to FFmpeg's `drawtext` filter.
