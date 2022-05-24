import { defaultPageEventProps, EventSinkContext, EventSinkDriver, PageEvent, PageEventBase } from "../index"
import { sanitizeObject, flatten, splitObject } from "../tools"

export type PostgrestDriverOpts = {
  url?: string
  apiKey?: string
  extraColumns?: (string | string[])[]
}

function getTableFromUrl(url: string): any {
  const parts = url
    .split("/")
    .map(el => el.trim())
    .filter(el => el && el !== "")
  return parts[parts.length - 1]
}

const defaultDataTypes: Record<keyof Required<PageEventBase>, string | null> = {
  user: null,
  timestamp: "TIMESTAMP",
  clickIds: "TEXT",
  eventId: "TEXT",
  eventType: "TEXT",
  host: "TEXT",
  ipAddress: "TEXT",
  localTimezoneOffset: "INTEGER",
  path: "TEXT",
  queryString: "TEXT",
  referrer: "TEXT",
  screenResolution: "TEXT",
  title: "TEXT",
  url: "TEXT",
  userAgent: "TEXT",
  userLanguage: "TEXT",
  utms: "TEXT",
  viewportSize: "TEXT",
}

function guessDataType(field: string, value: string | boolean | number | null) {
  const defaultType = defaultDataTypes[field as keyof Required<PageEventBase>]
  if (defaultType) {
    return defaultType
  }
  if (value && typeof value === "object") {
    return "JSONB"
  }
  if (typeof value === "string") {
    return "TEXT"
  } else if (typeof value === "boolean") {
    return "BOOLEAN"
  } else if (typeof value === "number") {
    return "DOUBLE PRECISION"
  } else {
    return "TEXT"
  }
}

function ddl(tableName: any, _object: Record<string, any>) {
  const object: Record<string, any> = { ..._object, user: _object.user || {} }
  console.log("Guessing ddl for", object)
  object.user.id = object.user.id || ""
  object.user.email = object.user.email || ""
  object.user.email = object.user.anonymousId || ""

  const statements = Object.entries(object)
    .map(([field, value]) => [field, guessDataType(field, value)])
    .filter(([, type]) => !!type)
    .map(([field, type]) => `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "${field}" ${type}`)

  //`ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "${field}" ${guessDataType(field, value)}`

  statements.push(`ALTER TABLE "${tableName}" ADD CONSTRAINT ${tableName.toLowerCase()}_pkey PRIMARY KEY ("eventId")`)
  return statements.join(";\n") + ";"
}

function parseQueryString(queryString: string) {
  return queryString
    .substring(queryString.indexOf("?") + 1)
    .split("&")
    .reduce((res, pair) => {
      const [key, value] = pair.split("=")
      return { ...res, [key]: value && decodeURIComponent(value) }
    }, {})
}

async function upsert(event: PageEvent, ctx: EventSinkContext, opts: PostgrestDriverOpts): Promise<any> {
  const url = opts.url || process.env.POSTGREST_URL
  const apiKey = opts?.apiKey || process.env.POSTGREST_API_KEY
  const keepColumns = [
    ...defaultPageEventProps,
    ["user", "email"],
    ["user", "id"],
    ["user", "anonymousId"],
    ...(opts?.extraColumns || []),
  ].filter(p => p !== "utms" && p !== "clickIds")
  const [base, extra] = splitObject(event as any, keepColumns)
  console.log("Split " + JSON.stringify(keepColumns), base, extra)
  const objectToInsert = {
    ...flatten(base),
    extra,
    timestamp: base.timestamp || new Date(),
    queryParams: event.queryString && event.queryString.length > 0 ? parseQueryString(event.queryString) : {},
  }
  console.log("Inserting", objectToInsert)
  if (!url) {
    throw new Error(`Please define opts.url or env.POSTGREST_URL`)
  }
  if (!apiKey) {
    throw new Error(`Please define opts.apiKey or env.POSTGREST_API_KEY`)
  }

  const headers = {
    apikey: apiKey,
    //    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    Prefer: "resolution=merge-duplicates",
  }
  const result = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(objectToInsert),
  })
  if (!result.ok) {
    throw new Error(
      `Failed to upsert data to ${url}. Code ${result.status} Error: ${await result.text()}. Payload ${JSON.stringify(
        objectToInsert
      )}. Headers: ${JSON.stringify(
        headers
      )}.\n\nPlease make sure that schema is matching data by running this script:\n\n${ddl(
        getTableFromUrl(url),
        objectToInsert
      )}`
    )
  }
}

export const postgrestDriver: EventSinkDriver<PostgrestDriverOpts> = opts => {
  return (event, ctx) => upsert(event, ctx, opts)
}
