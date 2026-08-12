'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

export default function DashboardPage() {
  const [user, setUser] = useState<any>(null)
  const [role, setRole] = useState<string>('Loading...')
  const router = useRouter()

  useEffect(() => {
    const checkUser = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      
      if (!user) {
        router.push('/login')
        return
      }

      setUser(user)

      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single()

      if (profile) {
        setRole(profile.role)
      }
    }

    checkUser()
  }, [router])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  if (!user) return <div className="p-8">Loading...</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <h1 className="text-xl font-bold text-gray-900">Fleet Operations</h1>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-600">
              {user.email} ({role})
            </span>
            <button
              onClick={handleLogout}
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-4 text-2xl font-bold text-gray-800">Welcome to Fleet Ops</h2>
          <p className="text-gray-600">
            You are logged in as <strong>{role}</strong>.
          </p>
          
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <h3 className="font-semibold text-gray-700">Active Trucks</h3>
              <p className="mt-2 text-3xl font-bold text-indigo-600">0</p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <h3 className="font-semibold text-gray-700">Dispatches</h3>
              <p className="mt-2 text-3xl font-bold text-green-600">0</p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <h3 className="font-semibold text-gray-700">Alerts</h3>
              <p className="mt-2 text-3xl font-bold text-red-600">0</p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <h3 className="font-semibold text-gray-700">Drivers</h3>
              <p className="mt-2 text-3xl font-bold text-blue-600">0</p>
            </div>
          </div>

          {role === 'ADMIN' && (
            <div className="mt-8 rounded-md bg-yellow-50 p-4 border border-yellow-200">
              <h3 className="font-semibold text-yellow-800">Admin Access Detected</h3>
              <p className="text-sm text-yellow-700">
                You have permissions to manage users and settings.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}