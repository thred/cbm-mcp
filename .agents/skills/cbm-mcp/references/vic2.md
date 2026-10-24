# VIC-II Graphics and Sprites (C64)

Use for locating and exporting graphics. Addresses are hexadecimal. Always
inspect live registers first; defaults are not guarantees.

## Where Graphics Live

The VIC-II addresses one 16 KiB bank at a time, selected by CIA2 (`$dd00` bits
1..0, inverted): `bankBase = (3 - ($dd00 & 3)) * $4000` (`$0000`, `$4000`,
`$8000`, `$c000`). Read `$dd00` with the I/O area mapped (monitor `bank io`).
The VIC sees RAM only, never BASIC/KERNAL ROM or I/O; read data with `bank ram`.
Exception: in banks 0 and 2 the VIC sees the character ROM instead of RAM at
`$1000-$1fff` / `$9000-$9fff` (read it with monitor `bank rom` at `$d000`), so no
sprite data can live there. `vice_export_font` handles this; `vice_export_sprites`
reads RAM only.

| Item        | Location                                                   |
| ----------- | ---------------------------------------------------------- |
| Screen RAM  | `bankBase + (($d018 >> 4) * $0400)`                        |
| Font        | `bankBase + (($d018 & $0e) * $0400)`                       |
| Bitmap      | `bankBase + (($d018 & $08) ? $2000 : $0000)`               |
| Sprite ptrs | `screenBase + $03f8 .. $03ff` (sprite 0..7), one byte each |
| Sprite data | `bankBase + pointer * 64`; 64-byte blocks, 63 bytes used   |

Color RAM (`$d800`) is not banked. Bitmap export is not covered yet.

## Sprite Format

A sprite is 24x21 pixels: 21 lines of 3 bytes, bit 7 = leftmost pixel, byte 63
unused. Per-sprite state lives in VIC registers:

| Register      | Meaning                                             |
| ------------- | --------------------------------------------------- |
| `$d015`       | Enable bits (bit n = sprite n).                     |
| `$d01c`       | Multicolor bits. Set = multicolor, clear = hires.   |
| `$d027-$d02e` | Individual sprite color (low nibble), sprites 0..7. |
| `$d025/$d026` | Shared multicolor 1 / 2 for all multicolor sprites. |
| `$d017/$d01d` | Double height / double width.                       |
| `$d000-$d010` | X/Y positions and X MSBs; `$d01b` priority.         |

- Hires: 24 pixels, bit 1 = sprite color, bit 0 = transparent.
- Multicolor: 12 double-wide pixels (still 24 screen pixels wide), bit pairs:
  `00` transparent, `01` `$d025`, `10` sprite color, `11` `$d026`.

## The Colors and Mode Are Not in the Sprite Data

The sprite bytes carry neither the mode nor any colors. They exist only in VIC
registers and pointers, and are only meaningful while the sprite is displayed:

- A sprite that is not currently enabled has no known mode or color.
- Even for an enabled sprite the registers are valid only at the current raster
  line. Sprite multiplexers rewrite pointers, positions, colors, and `$d01c`
  while the frame is drawn, so one data block can be shown with different
  colors/modes on different lines, and the same sprite number shows different
  data. A paused monitor snapshot shows only the state at the stopped raster
  line (`$d012`, `$d011` bit 7).
- Raster IRQ code, or a breakpoint/watchpoint on `$d027-$d02e`, `$d01c`,
  `$d015` and the pointers, is needed to learn the per-line state.
- Data in other banks or unused blocks can be anything (code, font, tables).

If unsure, treat as hires, white on black (background 0, color 1). Do not guess
multicolor from the data alone; confirm by registers, a screenshot, or code.

## Exporting With `vice_export_sprites`

- Default: the active bank (from `$dd00`) as a sheet of 64-byte blocks, 8 per
  row, hires white on black. Use `bank`, or `start` (RAM address) + `count`, for
  a specific region; `perRow` sets the sheet width; `scale` enlarges pixels.
- Supply `multicolor`, `foreground`, `multicolor1`, `multicolor2`, `background`
  (C64 color indexes 0-15) once known. They apply to the whole call, so regions
  with different modes/colors need separate calls.
- `format: "bin"` writes the plain bytes instead of an image.
- The result includes the paused-instant sprite state (enabled, mode, color,
  pointer and resolved address per sprite) as a hint for choosing the region
  and colors; it is subject to the multiplexer caveat above.
- The tool selects banks `io`/`ram` temporarily and restores `bank default`.

## Fonts

A character is 8 bytes (8 lines, bit 7 = leftmost pixel); a set is 256
characters = 2 KiB at `bankBase + ($d018 & $0e) * $0400`. Default fonts: the
ROM set at VIC `$1000` (bank 0, `$d018` low bits `100`/`101`) or the lowercase
set at `$1800`; custom sets live in RAM, anywhere in the bank on a 2 KiB boundary.

- Hires text: bit 1 = character color (color RAM per cell), bit 0 = `$d021`.
- Multicolor text (`$d016` bit 4): per cell, color RAM bit 3 selects
  multicolor, using color RAM bits 0-2 as the character color; otherwise
  the cell is hires. Multicolor cell pairs: `00` `$d021`, `01` `$d022`, `10`
  `$d023`, `11` color RAM. Extended color mode (`$d011` bit 6) uses only
  64 characters with `$d021-$d024` chosen by the top two screen-code bits.
- Whether a character is hires or multicolor is stored in color RAM, not in the
  font, and character colors are per cell. Mode and `$d018` may change per
  raster line (split screens, status bars); code may rewrite characters at
  runtime (animation, scrolling, effects). The export reads the state at
  the paused instant and cannot follow that.
- The set shown in text mode may also not be in use at all (bitmap mode:
  `$d011` bit 5), so check `bitmapMode` in the result.

### Exporting With `vice_export_font`

- Default (`scope: "font"`): the 256 characters at the current `$d018` font base
  in the active bank, 16 per row, hires white on black. Character ROM is read
  from `bank rom` automatically when the VIC sees it there (`charRomUsed`).
- If in doubt (several sets, split screens, custom/self-modifying fonts, unsure
  bank), use `scope: "bank"`: the whole 16 KiB bank as 2048 characters, 16
  per row; each 2 KiB set is a block of 16 sheet rows. Sprite data and code show up as noise. Pick `bank` explicitly to
  look at a non-active bank; `offset` and `count` select a region.
- `multicolor`, `foreground`, `background`, `multicolor1` (`$d022`),
  `multicolor2` (`$d023`) apply to the whole call. The result echoes the
  `$d016`/`$d021-$d023` state of the paused instant.
- `format: "bin"` writes the raw bytes.
