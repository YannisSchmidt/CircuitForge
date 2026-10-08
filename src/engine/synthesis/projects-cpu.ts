/**
 * Reference project: a small but complete 8-bit CPU.
 *
 * This is the deep end of the hierarchy, and all of it is real hardware built
 * from the chips of `projects.ts`:
 *
 *   CPU8 → ALU8 → RIPPLE_ADDER → FULL_ADDER → XOR / AND / OR gates
 *        → COUNTER → REGISTER → D flip-flop
 *        → ROM (AND/OR plane)
 *
 * Architecture (single cycle, one instruction per clock edge). The program memory
 * is combinational, so there is no instruction register: the ROM data output is
 * the instruction bus and the whole datapath is one combinational cloud between
 * the PC/accumulator registers, as in the textbook single-cycle design.
 *
 *   PC ──▶ ROM ══(instruction bus)═╦═▶ control decode ──▶ PC load / enable,
 *                                  │                      ACC enable, HALT
 *                                  ╚═▶ ALU(op, ACC, imm) ──▶ ACC (or the
 *                                                            immediate, on LDA)
 *
 * Instruction set (opcode in IR[7:4], immediate in IR[3:0]). The opcode *is*
 * the ALU op code — the ALU op word is {op0=IR4, op1=IR5, op2=IR7} — so there is
 * almost no decode logic, only wiring:
 *
 *   IR6 = 0: accumulator operations, `ACC ← ACC <op> imm`
 *     0000 AND imm    0001 OR imm     0010 XOR imm    0011 NOT A
 *     1000 ADD imm    1001 SUB imm    1010 INC A      1011 DEC A
 *
 *   IR6 = 1: control
 *     0100 NOP        0101 JMP addr   0110 LDA imm     1111 HLT
 *     any other IR6 = 1 pattern is a NOP.
 *
 * JMP writes neither the accumulator nor the ALU; HLT is sticky until the reset
 * input.
 *
 * Honest scope: synchronous single-cycle, no pipelining, no interrupts, no
 * memory-mapped I/O, byte-wide data and a 16-word program memory. Taking an
 * immediate as the ALU's B port means the ALU really computes with 8-bit B
 * (zero extended), so ADD/SUB/AND/… wrap at 8 bits and the carry output is the
 * true carry. The flags (Z, C) are ports; the demo program uses Z.
 */

import type { CircuitBuilder } from '../core/build.js';
import type { Chip } from '../core/chip.js';
import type { ParamBag } from '../core/library.js';
import type { Project } from '../core/project.js';
import { grid, numberParam, parametricChip } from './projects.js';

/**
 * Default demo program, and the regression vector for the CPU:
 *
 *   0: 63  LDA 3      A = 3     5: 81  ADD 1   (skipped by the jump)
 *   1: 84  ADD 4      A = 7     6: 8A  ADD 10  A = 14
 *   2: 21  XOR 1      A = 6     7: F0  HLT
 *   3: 92  SUB 2      A = 4     8..15: 00 (AND 0, never reached)
 *   4: 56  JMP 6      PC = 6
 *
 * final state: A = 14, PC = 7, HALT = 1.
 */
export const DEMO_PROGRAM = '63,84,21,92,56,81,8A,F0,00,00,00,00,00,00,00,00';

/** Build the CPU8 chip from the chips of the project (they must be registered). */
export function buildCpuChip(project: Project, options: { program?: string } = {}): Chip {
  const defaultProgram = options.program ?? DEMO_PROGRAM;
  return parametricChip(project, {
    id: 'cpu8',
    name: 'CPU8',
    description:
      '8-bit single-cycle accumulator CPU: program counter, program ROM, ALU and accumulator, with a sticky HALT.',
    params: [
      { name: 'program', kind: 'string', default: defaultProgram, description: 'Program image: 16 hex bytes, comma separated', sensitive: true },
    ],
    tags: ['cpu', 'hierarchy', 'showcase'],
    generator: (b: CircuitBuilder, params: ParamBag) => {
      const bits = 8;
      const program = String(params['program'] ?? defaultProgram);

      // ---------------------------------------------------------------- interface
      for (let i = 0; i < bits; i++) b.port(`A${i}`, 'output', `a${i}`, 1);
      for (let i = 0; i < 4; i++) b.port(`PC${i}`, 'output', `pc${i}`, 1);
      b.port('CLK', 'input', 'clk', 1);
      b.port('RUN', 'input', 'run', 1);
      b.port('RST', 'input', 'rst', 1);
      b.port('HALT', 'output', 'halt', 1);
      b.port('Z', 'output', 'zf', 1);
      b.port('C', 'output', 'cf', 1);
      b.port('PCCO', 'output', 'pcco', 1);

      const zero = b.add('logic_low', {}, grid(-3, 0));
      b.at(zero, 'OUT', 'zero');

      // ------------------------------------------- program counter (4 bits)
      const pc = project.instantiate(b, 'counter_n', { bits: 4 }, grid(0, 0));
      b.at(pc, 'CLK', 'clk').at(pc, 'RST', 'rst');
      for (let i = 0; i < 4; i++) {
        b.at(pc, `L${i}`, `ir${i}`);
        b.at(pc, `Q${i}`, `pc${i}`);
      }
      // The program counter's carry means "wrapped from 15 to 0": a program that
      // runs off the end of its 16 words sets it. It is a port, not a dangling
      // output, so the ERC stays quiet and the schematic can show it.
      b.at(pc, 'CO', 'pcco');

      // ------------------------------------------- program memory
      // The program memory is combinational and addressed by the PC, so its data
      // output *is* the instruction bus: there is no separate instruction
      // register to go stale. Everything downstream (decode, ALU operand, jump
      // target) is a combinational function of it, and every state element —
      // PC, accumulator, halt — latches the same edge. This is the textbook
      // single-cycle datapath; its clock period is the ROM→ALU→register delay,
      // which is exactly what the static timing analysis reports.
      const rom = project.instantiate(b, 'rom_n', { words: 16, width: 8, content: program }, grid(4, 0));
      for (let i = 0; i < 4; i++) b.at(rom, `A${i}`, `pc${i}`);
      for (let i = 0; i < 8; i++) b.at(rom, `D${i}`, `ir${i}`);

      // ------------------------------------------- control decode
      //
      // The opcode *is* the ALU op code: OP0 = IR4, OP1 = IR5, OP2 = IR7, so the
      // arithmetic half of the ALU is selected by IR7 and IR6 is free to mark the
      // control instructions. Almost nothing here is decode — it is wiring.
      const notIr7 = b.add('not_gate', { style: 'ideal' }, grid(12, 0));
      b.at(notIr7, 'IN1', 'ir7').at(notIr7, 'OUT', 'ir7n');
      const notIr6 = b.add('not_gate', { style: 'ideal' }, grid(12, 1));
      b.at(notIr6, 'IN1', 'ir6').at(notIr6, 'OUT', 'ir6n');
      const notIr5 = b.add('not_gate', { style: 'ideal' }, grid(12, 2));
      b.at(notIr5, 'IN1', 'ir5').at(notIr5, 'OUT', 'ir5n');
      const notIr4 = b.add('not_gate', { style: 'ideal' }, grid(12, 3));
      b.at(notIr4, 'IN1', 'ir4').at(notIr4, 'OUT', 'ir4n');

      // LDA = 0110, JMP = 0101, HLT = 1111; every other IR6 = 1 pattern is a NOP.
      const lda = b.add('and_gate', { style: 'ideal', inputs: 4 }, grid(13, 0));
      b.at(lda, 'IN1', 'ir6').at(lda, 'IN2', 'ir7n').at(lda, 'IN3', 'ir5').at(lda, 'IN4', 'ir4n');
      b.at(lda, 'OUT', 'is_lda');
      const jmp = b.add('and_gate', { style: 'ideal', inputs: 4 }, grid(13, 1));
      b.at(jmp, 'IN1', 'ir6').at(jmp, 'IN2', 'ir7n').at(jmp, 'IN3', 'ir5n').at(jmp, 'IN4', 'ir4');
      b.at(jmp, 'OUT', 'is_jmp');
      const hlt = b.add('and_gate', { style: 'ideal', inputs: 4 }, grid(13, 2));
      b.at(hlt, 'IN1', 'ir7').at(hlt, 'IN2', 'ir6').at(hlt, 'IN3', 'ir5').at(hlt, 'IN4', 'ir4');
      b.at(hlt, 'OUT', 'is_hlt');

      // ------------------------------------------- sticky halt
      const haltDff = b.add('dff', { initial: '0', tckq: 0 }, grid(16, 8));
      const haltOr = b.add('or_gate', { style: 'ideal', inputs: 2 }, grid(15, 8));
      b.at(haltOr, 'IN1', 'is_hlt').at(haltOr, 'IN2', 'halt').at(haltOr, 'OUT', 'halt_next');
      b.at(haltDff, 'D', 'halt_next').at(haltDff, 'CLK', 'clk').at(haltDff, 'RST', 'rst').at(haltDff, 'Q', 'halt');
      const notHalt = b.add('not_gate', { style: 'ideal' }, grid(17, 8));
      b.at(notHalt, 'IN1', 'halt').at(notHalt, 'OUT', 'haltn');

      // ------------------------------------------- control signals
      // Every IR6 = 0 instruction writes the accumulator (AND/OR/XOR/NOT A in the
      // low half, ADD/SUB/INC/DEC in the high half).
      // The accumulator is written by every ALU instruction (IR6 = 0) and by LDA
      // (which takes the immediate instead of the ALU result).
      const accWants = b.add('or_gate', { style: 'ideal', inputs: 2 }, grid(13, 4));
      b.at(accWants, 'IN1', 'ir6n').at(accWants, 'IN2', 'is_lda').at(accWants, 'OUT', 'acc_wants');
      const accEn = b.add('and_gate', { style: 'ideal', inputs: 3 }, grid(14, 1));
      b.at(accEn, 'IN1', 'acc_wants').at(accEn, 'IN2', 'haltn').at(accEn, 'IN3', 'run').at(accEn, 'OUT', 'acc_en');
      // pc_load = isJmp & !halt ; pc_en = !(pc_load | halt) & run
      const pcLoad = b.add('and_gate', { style: 'ideal', inputs: 2 }, grid(15, 1));
      b.at(pcLoad, 'IN1', 'is_jmp').at(pcLoad, 'IN2', 'haltn').at(pcLoad, 'OUT', 'pc_load');
      // The PC stops on the same edge that latches HALT: otherwise it would step
      // once past the halt instruction.
      const pcStop = b.add('or_gate', { style: 'ideal', inputs: 3 }, grid(16, 1));
      b.at(pcStop, 'IN1', 'pc_load').at(pcStop, 'IN2', 'halt').at(pcStop, 'IN3', 'is_hlt').at(pcStop, 'OUT', 'pc_stop');
      const notStop = b.add('not_gate', { style: 'ideal' }, grid(17, 1));
      b.at(notStop, 'IN1', 'pc_stop').at(notStop, 'OUT', 'pc_gon');
      const pcEn = b.add('and_gate', { style: 'ideal', inputs: 2 }, grid(18, 1));
      b.at(pcEn, 'IN1', 'pc_gon').at(pcEn, 'IN2', 'run').at(pcEn, 'OUT', 'pc_en');
      b.at(pc, 'EN', 'pc_en').at(pc, 'LOAD', 'pc_load');

      // ------------------------------------------- datapath
      const alu = project.instantiate(b, 'alu_n', { bits }, grid(2, 10));
      for (let i = 0; i < bits; i++) {
        b.at(alu, `A${i}`, `a${i}`);
        b.at(alu, `B${i}`, i < 4 ? `ir${i}` : 'zero');
        b.at(alu, `S${i}`, `alusr${i}`);
      }
      // The opcode *is* the ALU op code: OP0 = IR4, OP1 = IR5, OP2 = IR7.
      b.at(alu, 'OP0', 'ir4').at(alu, 'OP1', 'ir5').at(alu, 'OP2', 'ir7');
      b.at(alu, 'Z', 'zf').at(alu, 'C', 'cf');

      const acc = project.instantiate(b, 'register_n', { bits }, grid(8, 10));
      b.at(acc, 'CLK', 'clk').at(acc, 'RST', 'rst').at(acc, 'EN', 'acc_en');
      for (let i = 0; i < bits; i++) {
        const pick = project.instantiate(b, 'mux2', {}, grid(i, 12));
        b.at(pick, 'I0', `alusr${i}`).at(pick, 'I1', i < 4 ? `ir${i}` : 'zero');
        b.at(pick, 'S', 'is_lda').at(pick, 'Y', `accd${i}`);
        b.at(acc, `D${i}`, `accd${i}`);
        b.at(acc, `Q${i}`, `a${i}`);
      }
    },
  });
}
