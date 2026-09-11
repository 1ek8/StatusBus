"use client"
import Dashboard from "@/components/DashBoard";
import { useRouter } from "next/navigation";
import { clearToken } from "@/lib/auth";

export default function DashboardPage() {
    const router = useRouter();
    return <div>
        <Dashboard onLogout={() => {
            clearToken()
            router.push("/");
        }}/>
    </div>
}