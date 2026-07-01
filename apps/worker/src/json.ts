import { Prisma } from "@queans/db";

export function toInputJson(value: unknown): Prisma.InputJsonValue {
  if (value === undefined) {
    throw new Error("Cannot serialize undefined as required JSON");
  }

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function toNullableInputJson(value: unknown): Prisma.InputJsonValue | Prisma.NullTypes.JsonNull {
  return value === undefined ? Prisma.JsonNull : toInputJson(value);
}
