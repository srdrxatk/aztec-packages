// All code in this file needs to die once the public executor is phased out in favor of the AVM.
import { UnencryptedFunctionL2Logs, UnencryptedL2Log } from '@aztec/circuit-types';
import {
  CallContext,
  ContractStorageRead,
  ContractStorageUpdateRequest,
  FunctionData,
  Gas,
  type GasSettings,
  type GlobalVariables,
  type Header,
  L2ToL1Message,
  NoteHash,
  Nullifier,
  ReadRequest,
  SideEffect,
} from '@aztec/circuits.js';
import { Fr } from '@aztec/foundation/fields';

import { type AvmContext } from '../avm/avm_context.js';
import { AvmExecutionEnvironment } from '../avm/avm_execution_environment.js';
import { type AvmMachineState } from '../avm/avm_machine_state.js';
import { AvmContractCallResults } from '../avm/avm_message_call_result.js';
import { type JournalData } from '../avm/journal/journal.js';
import { Mov } from '../avm/opcodes/memory.js';
import { createSimulationError } from '../common/errors.js';
import { PackedValuesCache, SideEffectCounter } from '../index.js';
import { type PublicExecution, type PublicExecutionResult } from './execution.js';
import { PublicExecutionContext } from './public_execution_context.js';

/**
 * Convert a PublicExecution(Environment) object to an AvmExecutionEnvironment
 *
 * @param current
 * @param globalVariables
 * @returns
 */
export function createAvmExecutionEnvironment(
  current: PublicExecution,
  header: Header,
  globalVariables: GlobalVariables,
  gasSettings: GasSettings,
  transactionFee: Fr,
): AvmExecutionEnvironment {
  return new AvmExecutionEnvironment(
    current.contractAddress,
    current.callContext.storageContractAddress,
    current.callContext.msgSender,
    globalVariables.gasFees.feePerL2Gas,
    globalVariables.gasFees.feePerDaGas,
    /*contractCallDepth=*/ Fr.zero(),
    header,
    globalVariables,
    current.callContext.isStaticCall,
    current.callContext.isDelegateCall,
    current.args,
    gasSettings,
    transactionFee,
    current.functionData.selector,
  );
}

export function createPublicExecutionContext(avmContext: AvmContext, calldata: Fr[]): PublicExecutionContext {
  const sideEffectCounter = avmContext.persistableState.trace.accessCounter;
  const callContext = CallContext.from({
    msgSender: avmContext.environment.sender,
    storageContractAddress: avmContext.environment.storageAddress,
    functionSelector: avmContext.environment.temporaryFunctionSelector,
    isDelegateCall: avmContext.environment.isDelegateCall,
    isStaticCall: avmContext.environment.isStaticCall,
    sideEffectCounter: sideEffectCounter,
  });
  const functionData = new FunctionData(avmContext.environment.temporaryFunctionSelector, /*isPrivate=*/ false);
  const execution: PublicExecution = {
    contractAddress: avmContext.environment.address,
    callContext,
    args: calldata,
    functionData,
  };
  const packedArgs = PackedValuesCache.create([]);

  const context = new PublicExecutionContext(
    execution,
    avmContext.environment.header,
    avmContext.environment.globals,
    packedArgs,
    new SideEffectCounter(sideEffectCounter),
    avmContext.persistableState.hostStorage.publicStateDb,
    avmContext.persistableState.hostStorage.contractsDb,
    avmContext.persistableState.hostStorage.commitmentsDb,
    Gas.from(avmContext.machineState.gasLeft),
    avmContext.environment.transactionFee,
    avmContext.environment.gasSettings,
  );

  return context;
}

/**
 * Convert the result of an AVM contract call to a PublicExecutionResult for the public kernel
 *
 * @param execution
 * @param newWorldState
 * @param result
 * @returns
 */
export async function convertAvmResults(
  executionContext: PublicExecutionContext,
  newWorldState: JournalData,
  result: AvmContractCallResults,
  endMachineState: AvmMachineState,
): Promise<PublicExecutionResult> {
  const execution = executionContext.execution;

  const contractStorageReads: ContractStorageRead[] = newWorldState.storageReads.map(
    read => new ContractStorageRead(read.slot, read.value, read.counter.toNumber(), read.storageAddress),
  );
  const contractStorageUpdateRequests: ContractStorageUpdateRequest[] = newWorldState.storageWrites.map(
    write => new ContractStorageUpdateRequest(write.slot, write.value, write.counter.toNumber(), write.storageAddress),
  );
  // We need to write the storage updates to the DB, because that's what the ACVM expects.
  // Assumes the updates are in the right order.
  for (const write of newWorldState.storageWrites) {
    await executionContext.stateDb.storageWrite(write.storageAddress, write.slot, write.value);
  }

  const newNoteHashes = newWorldState.newNoteHashes.map(
    noteHash => new NoteHash(noteHash.noteHash, noteHash.counter.toNumber()),
  );
  const nullifierReadRequests: ReadRequest[] = newWorldState.nullifierChecks
    .filter(nullifierCheck => nullifierCheck.exists)
    .map(nullifierCheck => new ReadRequest(nullifierCheck.nullifier, nullifierCheck.counter.toNumber()));
  const nullifierNonExistentReadRequests: ReadRequest[] = newWorldState.nullifierChecks
    .filter(nullifierCheck => !nullifierCheck.exists)
    .map(nullifierCheck => new ReadRequest(nullifierCheck.nullifier, nullifierCheck.counter.toNumber()));
  const newNullifiers: Nullifier[] = newWorldState.newNullifiers.map(
    tracedNullifier =>
      new Nullifier(
        /*value=*/ tracedNullifier.nullifier,
        tracedNullifier.counter.toNumber(),
        /*noteHash=*/ Fr.ZERO, // NEEDED?
      ),
  );
  const unencryptedLogs: UnencryptedFunctionL2Logs = new UnencryptedFunctionL2Logs(
    newWorldState.newLogs.map(log => new UnencryptedL2Log(log.contractAddress, log.selector, log.data)),
  );
  const unencryptedLogsHashes = newWorldState.newLogsHashes.map(
    logHash => new SideEffect(logHash.logHash, logHash.counter),
  );
  const newL2ToL1Messages = newWorldState.newL1Messages.map(m => new L2ToL1Message(m.recipient, m.content));

  const returnValues = result.output;

  // TODO: Support nested executions.
  const nestedExecutions: PublicExecutionResult[] = [];
  // TODO keep track of side effect counters
  const startSideEffectCounter = Fr.ZERO;
  const endSideEffectCounter = Fr.ZERO;

  return {
    execution,
    nullifierReadRequests,
    nullifierNonExistentReadRequests,
    newNoteHashes,
    newL2ToL1Messages,
    startSideEffectCounter,
    endSideEffectCounter,
    newNullifiers,
    contractStorageReads,
    contractStorageUpdateRequests,
    returnValues,
    nestedExecutions,
    unencryptedLogsHashes,
    unencryptedLogs,
    reverted: result.reverted,
    revertReason: result.revertReason ? createSimulationError(result.revertReason) : undefined,
    startGasLeft: executionContext.availableGas,
    endGasLeft: endMachineState.gasLeft,
    transactionFee: executionContext.transactionFee,
  };
}

export function convertPublicExecutionResult(res: PublicExecutionResult): AvmContractCallResults {
  return new AvmContractCallResults(res.reverted, res.returnValues, res.revertReason);
}

export function updateAvmContextFromPublicExecutionResult(ctx: AvmContext, result: PublicExecutionResult): void {
  // We have to push these manually and not use the trace* functions
  // so that we respect the side effect counters.
  for (const readRequest of result.contractStorageReads) {
    ctx.persistableState.trace.publicStorageReads.push({
      storageAddress: ctx.environment.storageAddress,
      exists: true, // FIXME
      slot: readRequest.storageSlot,
      value: readRequest.currentValue,
      counter: new Fr(readRequest.sideEffectCounter ?? Fr.ZERO),
    });
  }

  for (const updateRequest of result.contractStorageUpdateRequests) {
    ctx.persistableState.trace.publicStorageWrites.push({
      storageAddress: ctx.environment.storageAddress,
      slot: updateRequest.storageSlot,
      value: updateRequest.newValue,
      counter: new Fr(updateRequest.sideEffectCounter ?? Fr.ZERO),
    });

    // We need to manually populate the cache.
    ctx.persistableState.publicStorage.write(
      ctx.environment.storageAddress,
      updateRequest.storageSlot,
      updateRequest.newValue,
    );
  }

  for (const nullifier of result.newNullifiers) {
    ctx.persistableState.trace.newNullifiers.push({
      storageAddress: ctx.environment.storageAddress,
      nullifier: nullifier.value,
      counter: new Fr(nullifier.counter),
    });
  }

  for (const noteHash of result.newNoteHashes) {
    ctx.persistableState.trace.newNoteHashes.push({
      storageAddress: ctx.environment.storageAddress,
      noteHash: noteHash.value,
      counter: new Fr(noteHash.counter),
    });
  }

  for (const message of result.newL2ToL1Messages) {
    ctx.persistableState.newL1Messages.push(message);
  }

  for (const log of result.unencryptedLogs.logs) {
    ctx.persistableState.newLogs.push(new UnencryptedL2Log(log.contractAddress, log.selector, log.data));
  }
}

const AVM_MAGIC_SUFFIX = Buffer.from([
  Mov.opcode, // opcode
  0x00, // indirect
  ...Buffer.from('000018ca', 'hex'), // srcOffset
  ...Buffer.from('000018ca', 'hex'), // dstOffset
]);

export function markBytecodeAsAvm(bytecode: Buffer): Buffer {
  return Buffer.concat([bytecode, AVM_MAGIC_SUFFIX]);
}

export function isAvmBytecode(bytecode: Buffer): boolean {
  const magicSize = AVM_MAGIC_SUFFIX.length;
  return bytecode.subarray(-magicSize).equals(AVM_MAGIC_SUFFIX);
}
