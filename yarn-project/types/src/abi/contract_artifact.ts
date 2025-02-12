import {
  type ABIParameter,
  type ABIParameterVisibility,
  type AbiType,
  type BasicValue,
  type ContractArtifact,
  type ContractNote,
  type FieldLayout,
  type FunctionArtifact,
  FunctionType,
  type IntegerValue,
  type StructValue,
  type TypedStructFieldValue,
} from '@aztec/foundation/abi';
import { Fr } from '@aztec/foundation/fields';

import {
  AZTEC_INITIALIZER_ATTRIBUTE,
  AZTEC_INTERNAL_ATTRIBUTE,
  AZTEC_PRIVATE_ATTRIBUTE,
  AZTEC_PUBLIC_ATTRIBUTE,
  AZTEC_PUBLIC_VM_ATTRIBUTE,
  type NoirCompiledContract,
} from '../noir/index.js';
import { mockVerificationKey } from './mocked_keys.js';

/**
 * Serializes a contract artifact to a buffer for storage.
 * @param artifact - Artifact to serialize.
 * @returns A buffer.
 */
export function contractArtifactToBuffer(artifact: ContractArtifact): Buffer {
  return Buffer.from(
    JSON.stringify(artifact, (key, value) => {
      if (
        key === 'bytecode' &&
        value !== null &&
        typeof value === 'object' &&
        value.type === 'Buffer' &&
        Array.isArray(value.data)
      ) {
        return Buffer.from(value.data).toString('base64');
      }
      return value;
    }),
    'utf-8',
  );
}

/**
 * Deserializes a contract artifact from storage.
 * @param buffer - Buffer to deserialize.
 * @returns Deserialized artifact.
 */
export function contractArtifactFromBuffer(buffer: Buffer): ContractArtifact {
  return JSON.parse(buffer.toString('utf-8'), (key, value) => {
    if (key === 'bytecode' && typeof value === 'string') {
      return Buffer.from(value, 'base64');
    }
    if (typeof value === 'object' && value !== null && value.type === 'Fr') {
      return new Fr(BigInt(value.value));
    }
    return value;
  });
}

/**
 * Gets nargo build output and returns a valid contract artifact instance.
 * @param input - Input object as generated by nargo compile.
 * @returns A valid contract artifact instance.
 */
export function loadContractArtifact(input: NoirCompiledContract): ContractArtifact {
  if (isContractArtifact(input)) {
    return input;
  }
  return generateContractArtifact(input);
}

/**
 * Checks if the given input looks like a valid ContractArtifact. The check is not exhaustive,
 * and it's just meant to differentiate between nargo raw build artifacts and the ones
 * produced by this compiler.
 * @param input - Input object.
 * @returns True if it looks like a ContractArtifact.
 */
function isContractArtifact(input: any): input is ContractArtifact {
  if (typeof input !== 'object') {
    return false;
  }
  const maybeContractArtifact = input as ContractArtifact;
  if (typeof maybeContractArtifact.name !== 'string') {
    return false;
  }
  if (!Array.isArray(maybeContractArtifact.functions)) {
    return false;
  }
  for (const fn of maybeContractArtifact.functions) {
    if (typeof fn.name !== 'string') {
      return false;
    }
    if (typeof fn.functionType !== 'string') {
      return false;
    }
  }
  return true;
}

/** Parameter in a function from a noir contract compilation artifact */
type NoirCompiledContractFunctionParameter = NoirCompiledContractFunction['abi']['parameters'][number];

/**
 * Generates a function parameter out of one generated by a nargo build.
 * @param param - Noir parameter.
 * @returns A function parameter.
 */
function generateFunctionParameter(param: NoirCompiledContractFunctionParameter): ABIParameter {
  const { visibility } = param;
  if ((visibility as string) === 'databus') {
    throw new Error(`Unsupported visibility ${param.visibility} for noir contract function parameter ${param.name}.`);
  }
  return { ...param, visibility: visibility as ABIParameterVisibility };
}

/** Function from a noir contract compilation artifact */
type NoirCompiledContractFunction = NoirCompiledContract['functions'][number];

/**
 * Generates a function build artifact. Replaces verification key with a mock value.
 * @param fn - Noir function entry.
 * @param contract - Parent contract.
 * @returns Function artifact.
 */
function generateFunctionArtifact(fn: NoirCompiledContractFunction, contract: NoirCompiledContract): FunctionArtifact {
  if (fn.custom_attributes === undefined) {
    throw new Error(
      `No custom attributes found for contract function ${fn.name}. Try rebuilding the contract with the latest nargo version.`,
    );
  }
  const functionType = getFunctionType(fn);
  const isInternal = fn.custom_attributes.includes(AZTEC_INTERNAL_ATTRIBUTE);

  // If the function is not unconstrained, the first item is inputs or CallContext which we should omit
  let parameters = fn.abi.parameters.map(generateFunctionParameter);
  if (hasKernelFunctionInputs(parameters)) {
    parameters = parameters.slice(1);
  }

  let returnTypes: AbiType[] = [];
  if (functionType === FunctionType.UNCONSTRAINED && fn.abi.return_type) {
    returnTypes = [fn.abi.return_type.abi_type];
  } else {
    const pathToFind = `${contract.name}::${fn.name}_abi`;
    const abiStructs: AbiType[] = contract.outputs.structs['functions'];

    const returnStruct = abiStructs.find(a => a.kind === 'struct' && a.path === pathToFind);

    if (returnStruct) {
      if (returnStruct.kind !== 'struct') {
        throw new Error('Could not generate contract function artifact');
      }

      const returnTypeField = returnStruct.fields.find(field => field.name === 'return_type');
      if (returnTypeField) {
        returnTypes = [returnTypeField.type];
      }
    }
  }

  return {
    name: fn.name,
    functionType,
    isInternal,
    isInitializer: fn.custom_attributes.includes(AZTEC_INITIALIZER_ATTRIBUTE),
    parameters,
    returnTypes,
    bytecode: Buffer.from(fn.bytecode, 'base64'),
    verificationKey: mockVerificationKey,
    debugSymbols: fn.debug_symbols,
  };
}

function getFunctionType(fn: NoirCompiledContractFunction): FunctionType {
  if (fn.custom_attributes.includes(AZTEC_PRIVATE_ATTRIBUTE)) {
    return FunctionType.SECRET;
  } else if (
    fn.custom_attributes.includes(AZTEC_PUBLIC_ATTRIBUTE) ||
    fn.custom_attributes.includes(AZTEC_PUBLIC_VM_ATTRIBUTE)
  ) {
    return FunctionType.OPEN;
  } else if (fn.is_unconstrained) {
    return FunctionType.UNCONSTRAINED;
  } else {
    // Default to a private function (see simple_macro_example_expanded for an example of this behavior)
    return FunctionType.SECRET;
  }
}

/**
 * Returns true if the first parameter is kernel function inputs.
 *
 * Noir macros #[aztec(private|public)] inject the following code
 * fn <name>(inputs: <Public|Private>ContextInputs, ...otherparams) {}
 *
 * Return true if this injected parameter is found
 */
function hasKernelFunctionInputs(params: ABIParameter[]): boolean {
  const firstParam = params[0];
  return firstParam?.type.kind === 'struct' && firstParam.type.path.includes('ContextInputs');
}

/**
 * Generates a storage layout for the contract artifact.
 * @param input - The compiled noir contract to get storage layout for
 * @returns A storage layout for the contract.
 */
function getStorageLayout(input: NoirCompiledContract) {
  const storage = input.outputs.globals.storage ? (input.outputs.globals.storage[0] as StructValue) : { fields: [] };
  const storageFields = storage.fields as TypedStructFieldValue<StructValue>[];

  if (!storageFields) {
    return {};
  }

  return storageFields.reduce((acc: Record<string, FieldLayout>, field) => {
    const name = field.name;
    const slot = field.value.fields[0].value as IntegerValue;
    const typ = field.value.fields[1].value as BasicValue<'string', string>;
    acc[name] = {
      slot: new Fr(BigInt(slot.value)),
      typ: typ.value,
    };
    return acc;
  }, {});
}

/**
 * Generates records of the notes with note type ids of the artifact.
 * @param input - The compiled noir contract to get note types for
 * @return A record of the note types and their ids
 */
function getNoteTypes(input: NoirCompiledContract) {
  type t = {
    kind: string;
    fields: [{ kind: string; sign: boolean; value: string }, { kind: string; value: string }];
  };

  const notes = input.outputs.globals.notes as t[];

  if (!notes) {
    return {};
  }

  return notes.reduce((acc: Record<string, ContractNote>, note) => {
    const name = note.fields[1].value as string;
    const id = new Fr(BigInt(note.fields[0].value));
    acc[name] = {
      id,
      typ: name,
    };
    return acc;
  }, {});
}

/**
 * Given a Nargo output generates an Aztec-compatible contract artifact.
 * @param compiled - Noir build output.
 * @returns Aztec contract build artifact.
 */
function generateContractArtifact(contract: NoirCompiledContract, aztecNrVersion?: string): ContractArtifact {
  return {
    name: contract.name,
    functions: contract.functions.map(f => generateFunctionArtifact(f, contract)),
    outputs: contract.outputs,
    storageLayout: getStorageLayout(contract),
    notes: getNoteTypes(contract),
    fileMap: contract.file_map,
    aztecNrVersion,
  };
}
