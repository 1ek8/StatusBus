"use client"
import React, { useEffect, useState } from 'react';
import {
    Monitor,
    User,
    X,
    LogOut,
    Edit3,
    Trash2,
    ExternalLink,
    Globe,
    AlertTriangle,
    Activity
} from 'lucide-react';

import axios from 'axios';
import { useRouter } from 'next/navigation';
import { BACKEND_URL } from '../lib/utils';
import { getToken, clearToken } from '../lib/auth'; 

interface Website {
    id: string;
    url: string;
    status: 'Up' | 'Down' | 'Unknown';
    responseTime: number;
    lastChecked: string;
}

interface DashboardProps {
    onLogout: () => void;
}



const Dashboard: React.FC<DashboardProps> = ({ onLogout }) => {
    const router = useRouter();
    const [ websites, setWebsites] = useState<Website[]>([]);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [websiteUrl, setWebsiteUrl] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [addError, setAddError] = useState<string | null>(null);

    const handleSessionExpired = () => {
        clearToken();
        router.push('/signin');
    };

    const errorMessage = (err: unknown): string => {
        if (axios.isAxiosError(err)) {
            const data = err.response?.data as { error?: string } | undefined;
            if (data?.error) return data.error;
            if (err.response?.status === 401) return "Your session has expired. Please sign in again.";
        }
        return "Something went wrong. Please try again.";
    };

    const fetchWebsites = async () => {
        setIsLoading(true);
        setError(null);
        try {
            const response = await axios.get(
            BACKEND_URL + "/websites",
            {
                headers: {
                Authorization: `Bearer ${getToken()}`,
                },
            }
            );
            setWebsites(response.data.websites);
        } catch (err) {
            if (axios.isAxiosError(err) && err.response?.status === 401) {
                setError("Your session has expired. Please sign in again.");
                setTimeout(handleSessionExpired, 2000);
            } else {
                setError(errorMessage(err));
            }
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchWebsites();
    }, []);

    const upSites = websites.filter(site => site.status === 'Up').length;
    const downSites = websites.filter(site => site.status === 'Down').length;
    const totalSites = websites.length;

    const handleEdit = (websiteId: string) => {
        console.log('Edit website:', websiteId);
    };

    const handleDelete = (websiteId: string) => {
        console.log('Delete website:', websiteId);
    };

    const handleGoTo = (url: string) => {
        window.open(url, '_blank');
    };

    const handleAddWebsite = async () => {
        if (!websiteUrl.trim()) 
            return;

        setIsSubmitting(true);
        setAddError(null);
        try {
            const response = await axios.post(`${BACKEND_URL}/website`, {
                url: websiteUrl.trim()
            },
            {
                headers: { Authorization: `Bearer ${getToken()}` }
            });
            
            // Add the new website to the local state
            const newWebsite: Website = {
                id: response.data.id,
                url: websiteUrl.trim(),
                status: 'Unknown',
                responseTime: 0,
                lastChecked: 'N/A'
            };
            
            setWebsites(prev => [...prev, newWebsite]);
            
            // Reset and close modal
            await fetchWebsites();
            setWebsiteUrl('');
            setIsModalOpen(false);
        } catch (err) {
            if (axios.isAxiosError(err) && err.response?.status === 401) {
                handleSessionExpired();
                return;
            }
            setAddError(errorMessage(err));
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleCloseModal = () => {
        setIsModalOpen(false);
        setWebsiteUrl('');
    };


    return (
        <div className="min-h-screen bg-slate-900">
            {/* Header */}
            <header className="bg-slate-800 border-b border-slate-700">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex justify-between items-center h-16">
                        <div className="flex items-center space-x-2">
                            <Monitor className="h-8 w-8 text-blue-500" />
                            <span className="text-xl font-bold text-white">StatusBus</span>
                        </div>

                        <div className="flex items-center space-x-4">
                            <div className="flex items-center space-x-2 text-slate-300">
                                <User className="h-5 w-5" />
                                <span className="hidden sm:inline">john@example.com</span>
                            </div>
                            <button
                                onClick={onLogout}
                                className="flex items-center space-x-2 text-slate-400 hover:text-white transition-colors px-3 py-2 rounded-lg hover:bg-slate-700"
                            >
                                <LogOut className="h-5 w-5" />
                                <span className="hidden sm:inline">Logout</span>
                            </button>
                        </div>
                    </div>
                </div>
            </header>

            {/* Main Content */}
            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {error && (
                    <div className="mb-6 flex items-center justify-between bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3" role="alert">
                        <div className="flex items-center space-x-2">
                            <AlertTriangle className="h-5 w-5 text-red-400" />
                            <p className="text-sm text-red-300">{error}</p>
                        </div>
                        {error.includes("session") ? (
                            <button
                                onClick={handleSessionExpired}
                                className="px-3 py-1.5 text-sm rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 transition-colors"
                            >
                                Sign in again
                            </button>
                        ) : (
                            <button
                                onClick={() => setError(null)}
                                className="text-red-400 hover:text-red-300 transition-colors"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        )}
                    </div>
                )}

                {/* Summary Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                    <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-slate-400 text-sm font-medium">Websites Up</p>
                                <p className="text-3xl font-bold text-green-400">{upSites}</p>
                            </div>
                            <div className="bg-green-500/10 p-3 rounded-lg">
                                <Activity className="h-8 w-8 text-green-400" />
                            </div>
                        </div>
                    </div>

                    <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-slate-400 text-sm font-medium">Websites Down</p>
                                <p className="text-3xl font-bold text-red-400">{downSites}</p>
                            </div>
                            <div className="bg-red-500/10 p-3 rounded-lg">
                                <AlertTriangle className="h-8 w-8 text-red-400" />
                            </div>
                        </div>
                    </div>

                    <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-slate-400 text-sm font-medium">Total Websites</p>
                                <p className="text-3xl font-bold text-blue-400">{totalSites}</p>
                            </div>
                            <div className="bg-blue-500/10 p-3 rounded-lg">
                                <Globe className="h-8 w-8 text-blue-400" />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Websites Table */}
                <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
                    <div className="px-6 py-4 border-b border-slate-700">
                        <div className="flex items-center justify-between">
                            <h2 className="text-xl font-semibold text-white">Monitored Websites</h2>
                            <button
                             onClick={() => setIsModalOpen(true)} 
                             className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition-colors text-sm font-medium">
                                Add Website
                            </button>
                        </div>
                    </div>

                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-slate-700/50">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-300 uppercase tracking-wider">
                                        Website
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-300 uppercase tracking-wider">
                                        Status
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-300 uppercase tracking-wider">
                                        Response Time
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-300 uppercase tracking-wider">
                                        Last Checked
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-300 uppercase tracking-wider">
                                        Actions
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-700">
                                {websites.map((website) => (
                                    <tr key={website.id} className="hover:bg-slate-700/30 transition-colors">
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <div>
                                                <div className="text-sm text-slate-400">{website.url}</div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <div className="flex items-center">
                                                <div className={`w-3 h-3 rounded-full mr-2 ${
                                                    website.status === "Up"
                                                    ? "bg-green-400"
                                                    : website.status === "Down"
                                                    ? "bg-red-400 animate-pulse"
                                                    : "bg-yellow-400 animate-pulse"
                                                }`}
                                                ></div>
                                                <span
                                                className={`text-sm font-medium ${
                                                    website.status === "Up"
                                                    ? "text-green-400"
                                                    : website.status === "Down"
                                                    ? "text-red-400"
                                                    : "text-yellow-400"
                                                }`}
                                                >
                                                {website.status}
                                                </span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <span className="text-sm text-slate-300">
                                                {website.status === 'Up' ? `${website.responseTime}ms` : 'N/A'}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <span className="text-sm text-slate-300">{website.lastChecked}</span>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <div className="flex items-center space-x-2">
                                                <button
                                                    onClick={() => handleEdit(website.id)}
                                                    className="p-2 text-slate-400 hover:text-blue-400 hover:bg-slate-700 rounded-lg transition-all duration-200"
                                                    title="Edit website"
                                                >
                                                    <Edit3 className="h-4 w-4" />
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(website.id)}
                                                    className="p-2 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded-lg transition-all duration-200"
                                                    title="Delete website"
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                </button>
                                                <button
                                                    onClick={() => handleGoTo(website.url)}
                                                    className="p-2 text-slate-400 hover:text-green-400 hover:bg-slate-700 rounded-lg transition-all duration-200"
                                                    title="Visit website"
                                                >
                                                    <ExternalLink className="h-4 w-4" />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Empty State (if no websites) */}    
                {!isLoading && websites.length === 0 && !error && (
                    <div className="bg-slate-800 rounded-xl border border-slate-700 p-12 text-center">
                        <Monitor className="h-16 w-16 text-slate-600 mx-auto mb-4" />
                        <h3 className="text-xl font-semibold text-white mb-2">No websites being monitored</h3>
                        <p className="text-slate-400 mb-6">
                            Add your first website to start monitoring its uptime and performance.
                        </p>
                        <button 
                         onClick = {() => setIsModalOpen(true)} 
                         className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg transition-colors font-medium">
                            Add Your First Website
                        </button>   
                    </div>
                )}
            </main>

            {/* Add Website Modal */}
            {isModalOpen && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                <div className="bg-slate-800 rounded-xl border border-slate-700 p-6 w-full max-w-md mx-4">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-xl font-semibold text-white">Add Website</h3>
                    <button
                    onClick={handleCloseModal}
                    className="text-slate-400 hover:text-white transition-colors"
                    >
                    <X className="h-5 w-5" />
                    </button>
                </div>
                
                <div className="space-y-4">
                    {addError && (
                        <p className="text-sm text-red-400" role="alert">{addError}</p>
                    )}
                    <div>
                    <label htmlFor="websiteUrl" className="block text-sm font-medium text-slate-300 mb-2">
                        Website URL
                    </label>
                    <input
                        id="websiteUrl"
                        type="url"
                        value={websiteUrl}
                        onChange={(e) => setWebsiteUrl(e.target.value)}
                        placeholder="https://example.com"
                        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    </div>
                    
                    <div className="flex space-x-3">
                    <button
                        onClick={handleCloseModal}
                        className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleAddWebsite}
                        disabled={!websiteUrl.trim() || isSubmitting}
                        className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:opacity-50 text-white rounded-lg transition-colors"
                    >
                        {isSubmitting ? 'Adding...' : 'Add Website'}
                    </button>
                    </div>
                </div>
                </div>
            </div>
            )}

        </div>
    );
};

export default Dashboard;