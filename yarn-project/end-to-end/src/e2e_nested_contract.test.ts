import { type AztecAddress, BatchCall, type DebugLogger, Fr, type PXE, type Wallet, toBigIntBE } from '@aztec/aztec.js';
import { ChildContract, ImportTestContract, ParentContract, TestContract } from '@aztec/noir-contracts.js';

import { setup } from './fixtures/utils.js';

describe('e2e_nested_contract', () => {
  let pxe: PXE;
  let wallet: Wallet;
  let logger: DebugLogger;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ teardown, pxe, wallet, logger } = await setup());
  });

  afterEach(() => teardown());

  describe('parent manually calls child', () => {
    let parentContract: ParentContract;
    let childContract: ChildContract;

    beforeEach(async () => {
      parentContract = await ParentContract.deploy(wallet).send().deployed();
      childContract = await ChildContract.deploy(wallet).send().deployed();
    });

    const getChildStoredValue = (child: { address: AztecAddress }) => pxe.getPublicStorageAt(child.address, new Fr(1));

    it('performs nested calls', async () => {
      await parentContract.methods
        .entry_point(childContract.address, childContract.methods.value.selector)
        .send()
        .wait();
    });

    it('fails simulation if calling a function not allowed to be called externally', async () => {
      await expect(
        parentContract.methods
          .entry_point(childContract.address, (childContract.methods as any).value_internal.selector)
          .prove(),
      ).rejects.toThrow(/Assertion failed: Function value_internal can only be called internally/);
    });

    it('performs public nested calls', async () => {
      await parentContract.methods
        .pub_entry_point(childContract.address, childContract.methods.pub_get_value.selector, 42n)
        .send()
        .wait();
    });

    it('enqueues a single public call', async () => {
      await parentContract.methods
        .enqueue_call_to_child(childContract.address, childContract.methods.pub_inc_value.selector, 42n)
        .send()
        .wait();
      expect(await getChildStoredValue(childContract)).toEqual(new Fr(42n));
    });

    it('fails simulation if calling a public function not allowed to be called externally', async () => {
      await expect(
        parentContract.methods
          .enqueue_call_to_child(
            childContract.address,
            (childContract.methods as any).pub_inc_value_internal.selector,
            42n,
          )
          .prove(),
      ).rejects.toThrow(/Assertion failed: Function pub_inc_value_internal can only be called internally/);
    });

    it('enqueues multiple public calls', async () => {
      await parentContract.methods
        .enqueue_call_to_child_twice(childContract.address, childContract.methods.pub_inc_value.selector, 42n)
        .send()
        .wait();
      expect(await getChildStoredValue(childContract)).toEqual(new Fr(85n));
    });

    it('enqueues a public call with nested public calls', async () => {
      await parentContract.methods
        .enqueue_call_to_pub_entry_point(childContract.address, childContract.methods.pub_inc_value.selector, 42n)
        .send()
        .wait();
      expect(await getChildStoredValue(childContract)).toEqual(new Fr(42n));
    });

    it('enqueues multiple public calls with nested public calls', async () => {
      await parentContract.methods
        .enqueue_calls_to_pub_entry_point(childContract.address, childContract.methods.pub_inc_value.selector, 42n)
        .send()
        .wait();
      expect(await getChildStoredValue(childContract)).toEqual(new Fr(85n));
    });

    // Regression for https://github.com/AztecProtocol/aztec-packages/issues/640
    it('reads fresh value after write within the same tx', async () => {
      await parentContract.methods
        .pub_entry_point_twice(childContract.address, childContract.methods.pub_inc_value.selector, 42n)
        .send()
        .wait();
      expect(await getChildStoredValue(childContract)).toEqual(new Fr(84n));
    });

    // Regression for https://github.com/AztecProtocol/aztec-packages/issues/1645
    // Executes a public call first and then a private call (which enqueues another public call)
    // through the account contract, if the account entrypoint behaves properly, it will honor
    // this order and not run the private call first which results in the public calls being inverted.
    it('executes public calls in expected order', async () => {
      const pubSetValueSelector = childContract.methods.pub_set_value.selector;
      const actions = [
        childContract.methods.pub_set_value(20n).request(),
        parentContract.methods.enqueue_call_to_child(childContract.address, pubSetValueSelector, 40n).request(),
      ];

      const tx = await new BatchCall(wallet, actions).send().wait();
      const extendedLogs = (
        await wallet.getUnencryptedLogs({
          fromBlock: tx.blockNumber!,
        })
      ).logs;
      const processedLogs = extendedLogs.map(extendedLog => toBigIntBE(extendedLog.log.data));
      expect(processedLogs).toEqual([20n, 40n]);
      expect(await getChildStoredValue(childContract)).toEqual(new Fr(40n));
    });
  });

  describe('importer uses autogenerated test contract interface', () => {
    let importerContract: ImportTestContract;
    let testContract: TestContract;

    beforeEach(async () => {
      logger.info(`Deploying importer test contract`);
      importerContract = await ImportTestContract.deploy(wallet).send().deployed();
      logger.info(`Deploying test contract`);
      testContract = await TestContract.deploy(wallet).send().deployed();
    });

    it('calls a method with multiple arguments', async () => {
      logger.info(`Calling main on importer contract`);
      await importerContract.methods.main_contract(testContract.address).send().wait();
    });

    it('calls a method no arguments', async () => {
      logger.info(`Calling noargs on importer contract`);
      await importerContract.methods.call_no_args(testContract.address).send().wait();
    });

    it('calls an open function', async () => {
      logger.info(`Calling openfn on importer contract`);
      await importerContract.methods.call_open_fn(testContract.address).send().wait();
    });

    it('calls an open function from an open function', async () => {
      logger.info(`Calling pub openfn on importer contract`);
      await importerContract.methods.pub_call_open_fn(testContract.address).send().wait();
    });
  });
});
