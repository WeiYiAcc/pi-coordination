import type { HookAPI } from "@mariozechner/pi-coding-agent";
import { FileBasedStorage } from "../state.js";

export default function reservationHook(pi: HookAPI) {
	const coordDir = process.env.PI_COORDINATION_DIR;
	const identity = process.env.PI_AGENT_IDENTITY;

	if (!coordDir || !identity) {
		return;
	}

	const storage = new FileBasedStorage(coordDir);

	pi.on("tool_call", async (event) => {
		const { toolName, input } = event;

		if (toolName !== "edit" && toolName !== "write") {
			return;
		}

		const filePath = input.path as string | undefined;
		if (!filePath) {
			return;
		}

		const reservation = await storage.checkReservation(filePath);

		if (reservation && reservation.agent !== identity && reservation.exclusive) {
			const expiresIn = Math.max(0, Math.floor((reservation.expiresAt - Date.now()) / 1000));

			return {
				block: true,
				reason:
					`File exclusively reserved by ${reservation.agent}: ${filePath}\n` +
					`Reason: ${reservation.reason}\n` +
					`Expires in: ${expiresIn}s\n\n` +
					`Options:\n` +
					`- Wait for the reservation to expire\n` +
					`- Send a message to ${reservation.agent} requesting early release\n` +
					`- Work on different files that aren't reserved`,
			};
		}
	});
}
