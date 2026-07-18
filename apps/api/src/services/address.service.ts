import type { Types } from "mongoose";
import { Customer, type Address, type CustomerDocument } from "../models/Customer.js";
import { AppError } from "../utils/AppError.js";

/**
 * Address book business logic. Addresses are embedded subdocuments in
 * `Customer.addresses` — there is no separate `Address` collection, so every
 * operation is scoped by loading the parent `Customer` by the authenticated
 * customer id first. A single `save()` on the parent document is atomic
 * (it's all one MongoDB document), so no multi-document session is needed to
 * enforce the "only one default shipping / one default billing" rule.
 */

interface AddressInput {
  label: string;
  line1: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
  isDefaultShipping?: boolean;
  isDefaultBilling?: boolean;
  rfc?: string;
  cfdiUse?: string;
  taxRegime?: string;
}

type UpdateAddressInput = Partial<AddressInput>;

const DEFAULT_FLAGS = ["isDefaultShipping", "isDefaultBilling"] as const;
type DefaultFlag = (typeof DEFAULT_FLAGS)[number];

const getCustomerOrThrow = async (customerId: string): Promise<CustomerDocument> => {
  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new AppError("Cliente no encontrado.", 404);
  }
  return customer;
};

const findAddressOrThrow = (customer: CustomerDocument, addressId: string) => {
  const address = customer.addresses.id(addressId);
  if (!address) {
    throw new AppError("Dirección no encontrada.", 404);
  }
  return address;
};

/** Unsets `flag` on every other address in the array (mutual exclusivity). */
const unsetOtherDefaults = (
  customer: CustomerDocument,
  currentId: Types.ObjectId | string,
  flag: DefaultFlag,
): void => {
  customer.addresses.forEach((address) => {
    if (address._id.toString() !== currentId.toString() && address[flag]) {
      address[flag] = false;
    }
  });
};

const applyDefaultExclusivity = (
  customer: CustomerDocument,
  currentId: Types.ObjectId | string,
  input: UpdateAddressInput,
): void => {
  for (const flag of DEFAULT_FLAGS) {
    if (input[flag] === true) {
      unsetOtherDefaults(customer, currentId, flag);
    }
  }
};

const list = async (customerId: string): Promise<Address[]> => {
  const customer = await getCustomerOrThrow(customerId);
  return customer.addresses;
};

const create = async (customerId: string, input: AddressInput): Promise<Address> => {
  const customer = await getCustomerOrThrow(customerId);
  customer.addresses.push(input);
  const created = customer.addresses[customer.addresses.length - 1]!;
  applyDefaultExclusivity(customer, created._id, input);
  await customer.save();
  return created;
};

const update = async (
  customerId: string,
  addressId: string,
  input: UpdateAddressInput,
): Promise<Address> => {
  const customer = await getCustomerOrThrow(customerId);
  const address = findAddressOrThrow(customer, addressId);
  Object.assign(address, input);
  applyDefaultExclusivity(customer, address._id, input);
  await customer.save();
  return address;
};

const remove = async (customerId: string, addressId: string): Promise<void> => {
  const customer = await getCustomerOrThrow(customerId);
  findAddressOrThrow(customer, addressId);
  customer.addresses.pull({ _id: addressId });
  await customer.save();
};

export type { AddressInput, UpdateAddressInput };
export { list, create, update, remove };
