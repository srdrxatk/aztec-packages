import { makeTuple } from '@aztec/foundation/array';
import { times } from '@aztec/foundation/collection';
import { Fq, Fr } from '@aztec/foundation/fields';
import { BufferReader, type Tuple, serializeToBuffer } from '@aztec/foundation/serialize';

import { VERIFICATION_KEY_LENGTH_IN_FIELDS } from '../constants.gen.js';
import { CircuitType } from './shared.js';

/**
 * Curve data.
 */
export class G1AffineElement {
  /**
   * Element's x coordinate.
   */
  public x: Fq;
  /**
   * Element's y coordinate.
   */
  public y: Fq;

  constructor(x: Fq | bigint, y: Fq | bigint) {
    this.x = typeof x === 'bigint' ? new Fq(x) : x;
    this.y = typeof y === 'bigint' ? new Fq(y) : y;
  }
  /**
   * Serialize as a buffer.
   * @returns The buffer.
   */
  toBuffer() {
    return serializeToBuffer(this.x, this.y);
  }

  /**
   * Deserializes from a buffer or reader, corresponding to a write in cpp.
   * @param buffer - Buffer  or BufferReader to read from.
   * @returns The G1AffineElement.
   */
  static fromBuffer(buffer: Buffer | BufferReader): G1AffineElement {
    const reader = BufferReader.asReader(buffer);
    return new G1AffineElement(Fq.fromBuffer(reader), Fq.fromBuffer(reader));
  }
}

/**
 * Used store and serialize a key-value map of commitments where key is the name of the commitment and value is
 * the commitment itself. The name can be e.g. Q_1, Q_2, SIGMA_1 etc.
 */
export class CommitmentMap {
  constructor(
    /**
     * An object used to store the commitments.
     */
    public record: { [name: string]: G1AffineElement },
  ) {}

  /**
   * Serialize as a buffer.
   * @returns The buffer.
   */
  toBuffer() {
    const values = Object.entries(this.record);
    return serializeToBuffer(values.length, ...values.flat());
  }

  /**
   * Deserializes from a buffer or reader, corresponding to a write in cpp.
   * @param buffer - Buffer or BufferReader to read from.
   * @returns The CommitmentMap.
   */
  static fromBuffer(buffer: Buffer | BufferReader): CommitmentMap {
    const reader = BufferReader.asReader(buffer);
    return new CommitmentMap(reader.readMap(G1AffineElement));
  }
}

/**
 * Provides a 'fields' representation of a circuit's verification key
 */
export class VerificationKeyAsFields {
  constructor(public key: Tuple<Fr, typeof VERIFICATION_KEY_LENGTH_IN_FIELDS>, public hash: Fr) {}

  /**
   * Serialize as a buffer.
   * @returns The buffer.
   */
  toBuffer() {
    return serializeToBuffer(this.key, this.hash);
  }
  toFields() {
    return [...this.key, this.hash];
  }

  /**
   * Deserializes from a buffer or reader, corresponding to a write in cpp.
   * @param buffer - Buffer to read from.
   * @returns The VerificationKeyAsFields.
   */
  static fromBuffer(buffer: Buffer | BufferReader): VerificationKeyAsFields {
    const reader = BufferReader.asReader(buffer);
    return new VerificationKeyAsFields(reader.readArray(VERIFICATION_KEY_LENGTH_IN_FIELDS, Fr), reader.readObject(Fr));
  }

  /**
   * Builds a fake verification key that should be accepted by circuits.
   * @returns A fake verification key.
   */
  static makeFake(seed = 1): VerificationKeyAsFields {
    return new VerificationKeyAsFields(makeTuple(VERIFICATION_KEY_LENGTH_IN_FIELDS, Fr.random, seed), Fr.random());
  }
}

export class VerificationKey {
  constructor(
    /**
     * For Plonk, this is equivalent to the proving system used to prove and verify.
     */
    public circuitType: CircuitType,
    /**
     * The number of gates in this circuit.
     */
    public circuitSize: number,
    /**
     * The number of public inputs in this circuit.
     */
    public numPublicInputs: number,
    /**
     * The commitments for this circuit.
     */
    public commitments: Record<string, G1AffineElement>,
    /**
     * Contains a recursive proof?
     */
    public containsRecursiveProof: boolean,
    /**
     * Recursion stack.
     */
    public recursiveProofPublicInputIndices: number[],
  ) {}

  /**
   * Serialize as a buffer.
   * @returns The buffer.
   */
  toBuffer() {
    return serializeToBuffer(
      this.circuitType,
      this.circuitSize,
      this.numPublicInputs,
      new CommitmentMap(this.commitments),
      this.containsRecursiveProof,
      serializeToBuffer(this.recursiveProofPublicInputIndices.length, this.recursiveProofPublicInputIndices),
    );
  }

  /**
	@@ -126,28 +97,14 @@ export class VerificationKeyAsFields {
   */
  static fromBuffer(buffer: Buffer | BufferReader): VerificationKey {
    const reader = BufferReader.asReader(buffer);
    return new VerificationKey(
      reader.readNumber(),
      reader.readNumber(),
      reader.readNumber(),
      reader.readObject(CommitmentMap).record,
      reader.readBoolean(),
      reader.readNumberVector(),
    );
  }

  /**
   * Builds a fake verification key that should be accepted by circuits.
   * @returns A fake verification key.
   */
  static makeFake(): VerificationKey {
    return new VerificationKey(
      CircuitType.ULTRA, // This is entirely arbitrary
      2048,
      116,
      {}, // Empty set of commitments
      false,
      times(16, i => i),
    );
  }
}
