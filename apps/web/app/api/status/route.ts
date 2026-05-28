import { db } from "@cap/database";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		await db().execute(sql`select 1`);

		return new Response("OK", {
			status: 200,
		});
	} catch {
		return new Response("DB unavailable", {
			status: 500,
		});
	}
}
