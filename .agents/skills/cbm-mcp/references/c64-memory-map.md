# C64 Memory Map

Use for the standard C64/6510, without cartridges or expansion remapping. All
addresses below are hexadecimal; 16-bit pointers are little-endian. Defaults are
not guarantees: inspect live values before diagnosing or changing anything.

## CPU Address Space

| Range         | Meaning                                                             |
| ------------- | ------------------------------------------------------------------- |
| `$0000-$00ff` | Zero page; `$0000/$0001` are the 6510's on-chip I/O port registers. |
| `$0100-$01ff` | CPU stack, addressed by the 8-bit SP; grows downward.               |
| `$0200-$03ff` | BASIC/KERNAL workspace, buffers, software vectors.                  |
| `$0400-$07e7` | Default 40x25 screen: 1000 screen-code bytes, not PETSCII.          |
| `$07f8-$07ff` | Default eight sprite pointers; tied to the selected screen base.    |
| `$0801-$9fff` | Default BASIC program/workspace; `$0800` normally contains zero.    |
| `$8000-$9fff` | RAM normally; cartridge ROM may overlay it.                         |
| `$a000-$bfff` | BASIC ROM or underlying RAM.                                        |
| `$c000-$cfff` | RAM; often used for machine code, but not inherently free.          |
| `$d000-$dfff` | I/O, character ROM, or RAM, selected by banking.                    |
| `$e000-$ffff` | KERNAL ROM or underlying RAM.                                       |

## Banking: Inspect Before Interpreting Bytes

`$0000` is the data-direction register (1=output); `$0001` is the port. Effective
bits 0=LORAM, 1=HIRAM, 2=CHAREN control mapping; input pins/pull-ups matter when
DDR bits are clear. Normal startup values are DDR `$2f`, port `$37`.

| Effective bits 2..0 | `$a000-$bfff` | `$d000-$dfff` | `$e000-$ffff` |
| ------------------- | ------------- | ------------- | ------------- |
| `000`, `100`        | RAM           | RAM           | RAM           |
| `001`               | RAM           | Character ROM | RAM           |
| `010`               | RAM           | Character ROM | KERNAL        |
| `011`               | BASIC         | Character ROM | KERNAL        |
| `101`               | RAM           | I/O           | RAM           |
| `110`               | RAM           | I/O           | KERNAL        |
| `111`               | BASIC         | I/O           | KERNAL        |

Writes beneath mapped ROM normally reach underlying RAM; mapped I/O writes reach
devices instead. CPU-visible bytes and a monitor RAM-bank dump may therefore
differ. Preserve unrelated port bits (including cassette control). With KERNAL
hidden, RAM interrupt vectors/handlers must be valid; `SEI` does not block NMI.
Cartridge GAME/EXROM lines, especially Ultimax, invalidate this simplified table.

## Useful RAM Locations

| Location                                    | Meaning                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `$002b/$002c`                               | BASIC text start; normally `$0801`.                                    |
| `$002d/$002e`, `$002f/$0030`, `$0031/$0032` | Variables start, arrays start, arrays end.                             |
| `$0033/$0034`, `$0037/$0038`                | String-space bottom, BASIC memory limit (normally `$a000`).            |
| `$007a/$007b`                               | BASIC text pointer used by CHRGET.                                     |
| `$0090`, `$00ba`                            | KERNAL I/O status, current file device.                                |
| `$00c6`, `$0277-$0280`                      | Keyboard-buffer length, ten-byte buffer.                               |
| `$00fb-$00fe`                               | Conventionally available zero-page workspace; check program ownership. |
| `$0286`, `$0288`                            | Current text color, screen-base high byte used by the editor.          |
| `$0314/$0315`, `$0316/$0317`, `$0318/$0319` | KERNAL-dispatched IRQ, BRK, NMI software vectors.                      |
| `$033c-$03fb`                               | Cassette buffer; not free while tape routines use it.                  |
| `$fffa/$fffb`, `$fffc/$fffd`, `$fffe/$ffff` | Hardware NMI, reset, IRQ/BRK vectors in the currently mapped memory.   |

## I/O and Video

| Range/register | Meaning and debugging caution                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| `$d000-$d3ff`  | VIC-II; 64-register block mirrored every `$40`.                                                        |
| `$d011/$d012`  | Raster high bit/control and raster low byte. Reads=current raster; writes=IRQ compare.                 |
| `$d016/$d018`  | Display mode/scroll and screen/character/bitmap placement.                                             |
| `$d019/$d01a`  | VIC IRQ status/enable; write a 1 to a status bit to acknowledge it.                                    |
| `$d01e/$d01f`  | Sprite collisions; reads can clear recorded collisions.                                                |
| `$d020/$d021`  | Border/background colors; `$d020` is decimal 53280.                                                    |
| `$d400-$d7ff`  | SID; registers mirrored every `$20`; most registers are write-only.                                    |
| `$d800-$dbff`  | Color RAM: low four bits meaningful; upper read bits are not stored color.                             |
| `$dc00-$dcff`  | CIA1: keyboard, joysticks, timers, IRQ; registers mirrored every `$10`.                                |
| `$dd00-$ddff`  | CIA2: VIC bank, serial/user port, timers, NMI; mirrored every `$10`.                                   |
| `$dc0d/$dd0d`  | Reading CIA interrupt status acknowledges pending flags; writes alter masks (bit 7 selects set/clear). |
| `$de00-$dfff`  | Expansion I/O; behavior depends on attached hardware.                                                  |

VIC-II has a separate 16 KiB view, not the CPU ROM/RAM map. With CIA2 port bits
configured as outputs, `bankBase = (3 - ($dd00 & 3)) * $4000`; preserve other bits
and check `$dd02` first. Screen base is `bankBase + (($d018 >> 4) * $0400)`;
character base is `bankBase + (($d018 & $0e) * $0400)`; bitmap base uses bit 3
(`+$0000` or `+$2000`). Sprite pointers occupy `screenBase+$03f8..$03ff` and
select 64-byte blocks within the VIC bank. VIC character-ROM windows occur at
physical `$1000-$1fff` and `$9000-$9fff`, independently of CPU CHAREN.

Reference: [STA C64 memory map](https://sta.c64.org/cbm64mem.html).
This is a focused technical summary; consult the source for less common workspace
bytes or complete chip bitfields, and confirm PAL/NTSC hardware before timing work.
