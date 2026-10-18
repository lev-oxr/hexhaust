# OBD2 and ISO-TP basics

Oct 18, 2026 · @Oleksandr Levchenko

## Who talks to whom

The scanner (the tester) and the ECUs share one CAN bus. OBD2 over CAN runs at 500 kbit/s with 11-bit IDs.

| CAN ID | Direction | Meaning |
| --- | --- | --- |
| `7DF` | tester → all ECUs | Functional (broadcast) request: any ECU that knows the answer replies |
| `7E0`–`7E7` | tester → one ECU | Physical request to one ECU; the engine is `7E0` |
| `7E8`–`7EF` | ECU → tester | Response ID = physical request ID + 8; the engine replies from `7E8` |

Every OBD frame carries exactly 8 data bytes. Unused bytes are padding, `55` in this project.

## Anatomy of a request and a response

The response `04 41 0C 1A F8` means 1726 rpm. Byte 0 is ISO-TP framing, bytes 1–2 echo the request, bytes 3–4 are the data.

```
7DF  02 01 0C 55 55 55 55 55    tester: engine speed?
7E8  04 41 0C 1A F8 55 55 55    engine: here it is
```

| Byte | Request | Response | Meaning |
| --- | --- | --- | --- |
| 0 | `02` | `04` | PCI (ISO-TP): Single Frame, number of useful bytes that follow |
| 1 | `01` | `41` | Service. A positive response = service + `40` |
| 2 | `0C` | `0C` | PID: what is being asked (engine speed) |
| 3–4 |  | `1A F8` | Data bytes A = `1A`, B = `F8` |
| 5–7 | `55…` | `55…` | Padding, ignored |

Worked example: A = `0x1A` = 1 × 16 + 10 = 26, B = `0xF8` = 15 × 16 + 8 = 248.

```latex
\text{rpm} = \frac{256A + B}{4} = \frac{256 \cdot 26 + 248}{4} = \frac{6904}{4} = 1726
```

256 × A + B is simply the 16-bit number `0x1AF8`. Dividing by 4 gives a resolution of 0.25 rpm.

The simulated ECU will handle five services:

- `01` current data
- `03` stored trouble codes
- `04` clear trouble codes
- `07` pending trouble codes
- `09` vehicle information, such as the VIN

An ECU that does not support a service answers a physical request with `7F <service> 11` and stays silent on a broadcast one.

## Five PIDs to decode by hand

Four of the five PIDs use one data byte; only engine speed uses two. In step 2 each row becomes a `PidDef` with `decode` and `encode`.

| PID | Name | Data bytes | Formula | Range |
| --- | --- | --- | --- | --- |
| `04` | Calculated engine load | 1 | A × 100 / 255 | 0–100 % |
| `05` | Engine coolant temperature | 1 | A − 40 | −40 to 215 °C |
| `0C` | Engine speed | 2 | (256 × A + B) / 4 | 0–16,383.75 rpm |
| `0D` | Vehicle speed | 1 | A | 0–255 km/h |
| `2F` | Fuel tank level | 1 | A × 100 / 255 | 0–100 % |

Why the formulas look like this:

- `−40` lets one unsigned byte cover sub-zero temperatures.
- `× 100 / 255` stretches 0–255 onto 0–100 %.
- `/ 4` gives fractional rpm without sending fractions on the bus.

## ISO-TP: when 7 bytes are not enough

A Single Frame holds at most 7 message bytes, because byte 0 is the PCI. The VIN response is `49 02 01` plus 17 characters, 20 bytes in total, so ISO-TP splits it across four frames plus one Flow Control.

&#91;embedded content: VIN read over ISO-TP · 5 frames\]

Read top to bottom: the highlighted First Frame carries the total length, and the ECU waits for Flow Control before sending the rest.

| PCI | Frame type | Sent by | What it carries |
| --- | --- | --- | --- |
| `0L` | Single Frame | either | L = length, up to 7 bytes |
| `1L LL` | First Frame | sender | 12-bit total length (up to 4095 bytes) + the first 6 bytes |
| `30 BS ST` | Flow Control | receiver | `0` = continue; BS = frames before the next Flow Control (`00` = all); ST = minimum gap between frames |
| `2N` | Consecutive Frame | sender | N = sequence counter 1, 2 … F, then 0; 7 bytes each |

In the VIN read, 6 + 7 + 7 = 20 bytes, and the VIN is `1M8GDM9AXKP042788`. Flow Control goes to the physical address of the ECU that answered: `7E8` − 8 = `7E0`.

Why the First Frame is needed:

1. It states the total length up front, so the receiver knows how much to expect and when the message is complete.
2. It announces that more is coming, and the receiver answers with Flow Control. The ECU does not flood the bus before the tester is ready.
3. It starts the sequence count, so a lost or duplicated Consecutive Frame shows up.

A real ELM327 does all of this itself and returns the reassembled message. That is why `Transport` works with messages, not frames. In the simulator you write ISO-TP yourself in step 5.

## Reading order

1. [OBD2 Explained](https://csselectronics.com/pages/obd2-explained-simple-intro) and the [video](https://www.youtube.com/watch?v=YcwBeNQbJ5A) from CSS Electronics: connector, services, PIDs, OBD2 on CAN. Skip the parts about their loggers.
2. [OBD2 PID table with converter](https://www.csselectronics.com/pages/obd2-pid-table-on-board-diagnostics-j1979): find the five PIDs above and check the frames below.
3. [UDS Explained](https://www.csselectronics.com/pages/uds-protocol-tutorial-unified-diagnostic-services): read only the ISO-TP section on frame types.
