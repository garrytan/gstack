# Landscape Gate

Intro text under the first heading.

## Negative: screenshot stays portrait

![just a screenshot of the app](./diagram-assets/wide-screenshot.png)

## Positive: alt-hinted wide image promotes

![architecture diagram of the system](./diagram-assets/wide-arch.png)

## Positive: directive forces a small image

![small forced](./diagram-assets/red-box.png){page=landscape}

## Positive: wide diagram auto-promotes

```mermaid title="Wide sequence"
sequenceDiagram
  participant A as seqalpha
  participant B as seqbeta
  participant C as seqgamma
  participant D as seqdelta
  participant E as seqepsilon
  participant F as seqzeta
  participant G as seqeta
  participant H as seqtheta
  participant I as seqiota
  participant J as seqkappa
  A->>J: long hop
  B->>I: cross
```

## Negative: directive vetoes a wide diagram

```mermaid page=portrait
sequenceDiagram
  participant A as vetoalpha
  participant B as vetobeta
  participant C as vetogamma
  participant D as vetodelta
  participant E as vetoepsilon
  participant F as vetozeta
  participant G as vetoeta
  participant H as vetotheta
  participant I as vetoiota
  participant J as vetokappa
  A->>J: long hop
```

Closing text.
