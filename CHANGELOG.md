# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-10-24

First release.

### Added

- Virtual CAN bus, a simulated engine ECU and a scanner with a request queue, polling and a 100 ms timeout.
- PID and DTC dictionaries (15 PIDs). Click a frame in the bus log to see a byte-by-byte breakdown with the formula and your numbers filled in.
- ISO-TP for VIN and trouble codes: First Frame, Flow Control, Consecutive Frames.
- Car model: key, accelerator pedal, gears and warm-up.
- Faults: misfire, vacuum leak, worn catalyst. Two-trip codes are pending first (mode 07), then stored (mode 03) with the MIL on; mode 04 clears them.
- Slow-ECU simulation. Late responses are marked in the bus log.
- Real car through a CANable adapter (slcan over Web Serial): listen-only mode, a block on state-changing services by default, raw log download.
- CI on pull requests and GitHub Pages deploy.

### Known limitations

- Not yet tested on a real car.
