"use client";

import { Button, Label } from "@cap/ui";
import type { Organisation } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { updateOrganizationDetails } from "@/actions/organization/update-details";
import { useDashboardContext } from "../../../Contexts";

export const AutoJoinDomain = () => {
	const { activeOrganization } = useDashboardContext();
	const [domain, setDomain] = useState(
		activeOrganization?.organization.autoJoinDomain ?? null,
	);
	const [saveLoading, setSaveLoading] = useState(false);
	const router = useRouter();
	const inputId = useId();

	const handleSave = async () => {
		try {
			setSaveLoading(true);
			await updateOrganizationDetails({
				autoJoinDomain: domain || null,
				organizationId: activeOrganization?.organization
					.id as Organisation.OrganisationId,
			});
			toast.success("Settings updated successfully");
			router.refresh();
		} catch (error) {
			console.error("Error updating settings:", error);
			toast.error("An error occurred while updating settings");
		} finally {
			setSaveLoading(false);
		}
	};

	return (
		<div className="flex-1 space-y-4">
			<div className="space-y-1">
				<Label htmlFor={inputId}>Auto-join domain</Label>
				<p className="text-sm text-gray-10">
					New users whose email matches this domain will automatically join your
					organization as members. Enter a single domain (e.g.{" "}
					<code className="text-xs bg-gray-3 px-1 py-0.5 rounded">
						company.com
					</code>
					).{" "}
					<span className="font-medium text-gray-11">
						Leave blank to disable auto-join.
					</span>
				</p>
			</div>
			<div className="flex flex-col gap-3 w-full h-fit">
				<input
					className="flex px-4 py-3 w-full font-thin transition-all duration-200 text-[16px] md:text-[13px] text-gray-12 bg-gray-1 border-gray-4 outline-0 focus:bg-gray-2 rounded-xl hover:bg-gray-2 border-[1px] focus:border-gray-5 placeholder:text-gray-8 ring-0 ring-gray-2 focus:ring-1 focus:ring-gray-12 focus:ring-offset-2 ring-offset-gray-3 hover:placeholder:text-gray-12 placeholder:duration-200"
					type="text"
					placeholder="e.g. company.com"
					value={domain ?? ""}
					id={inputId}
					name="autoJoinDomain"
					onChange={(e) => {
						setDomain(e.target.value || null);
					}}
				/>
				<div>
					<Button
						className="min-w-fit"
						type="submit"
						spinner={saveLoading}
						size="sm"
						variant="dark"
						disabled={
							saveLoading ||
							(domain ?? null) ===
								(activeOrganization?.organization.autoJoinDomain ?? null)
						}
						onClick={handleSave}
					>
						{saveLoading ? null : "Save"}
					</Button>
				</div>
			</div>
		</div>
	);
};

export default AutoJoinDomain;
