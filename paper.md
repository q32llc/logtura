EMA stdev is not the same as rolling-window stdev. It is exponentially weighted, so old samples never fully disappear. But for anomaly scoring,
  normalization, throttling, drift tracking, etc., it is usually better than a hard rolling window.

  You can maintain a decayed live frequency score for each event stream using EMA-style decay instead of a fixed rolling window. Then compute an EMA mean
  and variance over that frequency itself, producing a streaming z-score that measures how unusual the current activity is relative to its own historical
  baseline. This cleanly separates “always busy” from “suddenly spiking” without storing raw event history.

  Each token, token pair, template, service, status code, endpoint, or error phrase gets a decayed frequency, then an EMA baseline, then a surprise score.
  The result is cheap anomaly detection over logs: not “show me errors,” but “show me which words, patterns, and combinations are suddenly overrepresented
  relative to their own normal behavior.”

  Raw logs have infinite cardinality because timestamps, UUIDs, IDs, IPs, and paths constantly generate novel tokens that destroy meaningful frequency
  analysis. A semantic normalization layer converts logs into stable symbolic templates and typed placeholders, allowing structurally similar events to
  collapse into the same statistical stream. Once normalized, EMA-based frequency and deviation scoring can detect genuinely unusual patterns instead of
  noise from unique values.

  What does not really exist in a clean generalized form is: logs → stable semantic atoms/templates → online adaptive statistical modeling.

  Drain3 is probably the canonical prior art. It parses raw log messages into structured templates in a streaming manner, separating constant template text
  from variable runtime fields

  The system must effectively build a live probabilistic ontology.

  That is much closer to how humans debug systems. Engineers mentally discard fake novelty almost instantly. The hard problem is teaching machines to do
  that cheaply and continuously on raw streams.

  Drain’s paper frames the same problem: raw logs are unstructured, so a typical log-analysis pipeline first parses raw messages, then applies
  mining/anomaly models. Drain was designed specifically to do that parsing online instead of offline batch processing.

  Drain3 can be ported to rust, where we can use the output to feed the EMA engine - all designed as a vector plugin.
