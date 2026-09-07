using Xunit;

// These tests run against the real machine: one GPU, one hardware encoder, one desktop, one
// named pipe, and a WebRTC stack that does DTLS handshakes. Several of them assert timing —
// frames per second, milliseconds per frame, frames arriving inside a window — and those
// numbers only mean something when nothing else on the box is competing for the same
// hardware.
//
// Run in parallel they measure the test scheduler instead, and fail in whichever order the
// machine happened to be busy. Serial costs about twenty seconds and makes a failure mean
// what it says.
[assembly: CollectionBehavior(DisableTestParallelization = true)]
