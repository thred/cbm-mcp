# NMOS 6510 Assembly (English)

The C64 6510 uses the NMOS 6502 instruction set: 56 documented mnemonics, 151
documented opcode encodings. It is not a 65C02: no `BRA`, `STZ`, `PHX`, or
`LDA (zp)` mode. Undocumented opcodes exist; verify their exact encoding and CPU
behavior separately rather than replacing them with guessed instructions.

## Registers, Flags, and Addressing

`A`, `X`, `Y`, `SP` are 8-bit; `PC` is 16-bit. Status bits 7..0 are
`N V 1 B D I Z C`: negative, overflow, constant bit, stacked break marker,
decimal, IRQ-disable, zero, carry. B is not an independently latched CPU flag.
Below, `M` is the operand byte and `NZ` means N/Z are updated from the result.

| Mode                  | Example       | Bytes | Meaning                                                       |
| --------------------- | ------------- | ----- | ------------------------------------------------------------- |
| Implied / accumulator | `CLC` / `ASL` | 1     | No operand / operate on A.                                    |
| Immediate             | `LDA #$10`    | 2     | Literal `$10`, not memory at `$0010`.                         |
| Zero page             | `LDA $fb`     | 2     | Address `$00fb`.                                              |
| Zero-page indexed     | `LDA $fb,X`   | 2     | Add index; wrap within zero page.                             |
| Absolute              | `LDA $c000`   | 3     | 16-bit address; encoded low byte first.                       |
| Absolute indexed      | `LDA $c000,Y` | 3     | Add index to the 16-bit address.                              |
| Indexed indirect      | `LDA ($fb,X)` | 2     | Add X to zp pointer address, then dereference.                |
| Indirect indexed      | `LDA ($fb),Y` | 2     | Dereference zp pointer, then add Y.                           |
| Absolute indirect     | `JMP ($c000)` | 3     | Read a 16-bit jump target from memory.                        |
| Relative              | `BNE .loop`   | 2     | Signed -128..127 displacement from PC after this instruction. |

Not every instruction supports every mode. LDA/ADC/SBC/AND/ORA/EOR/CMP support
immediate, zp, zp-X, absolute, absolute-X/Y, and both zp indirect modes. STA uses
the same memory modes, never immediate. LDX/STX use zp-Y instead of zp-X;
LDY/STY use zp-X. LDX additionally supports absolute-Y; LDY absolute-X.
CPX/CPY allow immediate/zp/absolute; BIT only zp/absolute. Memory INC/DEC and
shifts/rotates allow zp/zp-X/absolute/absolute-X; only shifts/rotates also use A.

## Complete Documented Mnemonic Reference

| Mnemonics                         | English operation                                                                  | Flags changed   |
| --------------------------------- | ---------------------------------------------------------------------------------- | --------------- |
| `LDA`, `LDX`, `LDY`               | Load memory/immediate into A, X, Y.                                                | NZ              |
| `STA`, `STX`, `STY`               | Store A, X, Y to memory.                                                           | None            |
| `TAX`, `TAY`, `TXA`, `TYA`, `TSX` | Copy A->X, A->Y, X->A, Y->A, SP->X.                                                | NZ              |
| `TXS`                             | Copy X->SP.                                                                        | None            |
| `ADC`                             | A = A + M + C.                                                                     | NVZC            |
| `SBC`                             | A = A - M - (1-C); C=1 means no borrow.                                            | NVZC            |
| `AND`, `ORA`, `EOR`               | A = A AND M, OR M, XOR M.                                                          | NZ              |
| `INC`, `DEC`                      | Increment/decrement memory, wrapping at 8 bits.                                    | NZ              |
| `INX`, `INY`, `DEX`, `DEY`        | Increment/decrement X/Y, wrapping at 8 bits.                                       | NZ              |
| `ASL`, `LSR`                      | Shift left/right; outgoing bit enters C, zero enters other end.                    | NZC             |
| `ROL`, `ROR`                      | Rotate left/right through carry; old C enters result.                              | NZC             |
| `CMP`, `CPX`, `CPY`               | Compare A/X/Y with M as subtraction without storing result.                        | NZC             |
| `BIT`                             | Z=(A AND M)==0; N=M bit 7, V=M bit 6; A unchanged.                                 | NVZ             |
| `JMP`                             | Jump to absolute or indirectly addressed target.                                   | None            |
| `JSR`, `RTS`                      | Call subroutine / return (pull saved address, then add 1).                         | None            |
| `RTI`                             | Pull status and exact PC saved by an interrupt.                                    | Restores status |
| `BCC`, `BCS`                      | Branch if C=0 / C=1.                                                               | None            |
| `BEQ`, `BNE`                      | Branch if Z=1 / Z=0.                                                               | None            |
| `BPL`, `BMI`                      | Branch if N=0 / N=1.                                                               | None            |
| `BVC`, `BVS`                      | Branch if V=0 / V=1.                                                               | None            |
| `CLC`, `SEC`                      | Clear/set carry.                                                                   | C               |
| `CLD`, `SED`                      | Clear/set decimal arithmetic mode.                                                 | D               |
| `CLI`, `SEI`                      | Clear/set IRQ-disable; NMI is not masked.                                          | I               |
| `CLV`                             | Clear overflow.                                                                    | V               |
| `PHA`, `PHP`                      | Push A / a status copy (B and bit 5 set).                                          | None            |
| `PLA`                             | Pull A.                                                                            | NZ              |
| `PLP`                             | Pull status; B is not a persistent CPU flag.                                       | Restores status |
| `NOP`                             | No operation.                                                                      | None            |
| `BRK`                             | Software interrupt via IRQ/BRK vector; stacked return PC is opcode address+2, B=1. | I set           |

## Debugging Traps and Timing

- Use `CLC` before binary addition, `SEC` before subtraction unless deliberately
  chaining carry. Use `CLD` if binary arithmetic is intended. NMOS decimal mode
  adjusts ADC/SBC, but N/Z/V do not describe the adjusted BCD result as expected
  from binary arithmetic. IRQ/BRK do not automatically clear D.
- CMP's C reports unsigned >=; Z reports equality. BMI/BPL only test N, not a
  general signed comparison; signed subtraction needs N XOR V and overflow handling.
- Stack pushes write `$0100+SP`, then decrement SP; pulls increment first. JSR
  pushes the address of its final operand byte, high then low; RTS adds one.
  IRQ/NMI/BRK stack PC then status. Use RTI, not RTS, for interrupt returns.
- `JMP ($xxff)` reads the target high byte from `$xx00`, not the next page.
  Zero-page indirect pointer high-byte fetch also wraps `$ff` to `$00`.
- Memory read-modify-write instructions write the original byte before the new
  byte. On I/O this can acknowledge IRQs or cause other unintended effects.
- Typical cycles for LDA/ALU/CMP: immediate 2, zp 3, zp-X 4, absolute 4,
  absolute-X/Y 4 (+1 on page crossing), `(zp,X)` 6, `(zp),Y` 5 (+1 crossing).
  STA is zp 3, zp-X 4, absolute 4, absolute-X/Y 5, `(zp,X)`/`(zp),Y` 6.
- Shifts/rotates use 2 cycles on A; memory RMW uses zp 5, zp-X 6, absolute 6,
  absolute-X 7. Branches use 2 cycles, +1 if taken, +1 if the taken branch crosses
  a page. JSR/RTS/RTI take 6 cycles, BRK 7, JMP absolute 3 / indirect 5.
- These are CPU instruction cycles, not guaranteed elapsed raster time: VIC-II
  badlines and sprite DMA stall CPU execution; PAL/NTSC and VIC revision matter.

Sources: [German C64-Wiki instruction category](https://www.c64-wiki.de/wiki/Kategorie:Assembler-Befehl)
and [instruction overview](https://www.c64-wiki.de/wiki/%C3%9Cbersicht_6502-Assemblerbefehle).
English technical summary, not a verbatim article translation. German terminology:
Ladebefehl=load, Speicherbefehl=store, Sprung=jump/branch, Uebertrag=carry,
Adressierungsart=addressing mode, Taktzyklen=cycles; `(RAUTE)` in page titles means `#`.
