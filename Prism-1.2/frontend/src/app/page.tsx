'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import Link from 'next/link'

export default function Home() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState<any>(null)

  useEffect(() => {
    // Check active session
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      
      if (!session) {
        // No session? Go to login
        router.push('/login')
      } else {
        // Has session? Stay here (Dashboard will go here later)
        setUser(session.user)
        setLoading(false)
      }
    }

    checkSession()

    // Listen for auth changes (login/logout)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        router.push('/login')
      } else {
        setUser(session.user)
        setLoading(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [router])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-900 text-white">
        <div className="text-xl">Loading Fleet Ops...</div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-gray-900 text-white">
      <h1 className="mb-4 text-4xl font-bold">Fleet Operations Dashboard</h1>
      <p className="mb-8 text-gray-400">Welcome, {user?.email}</p>
      
      <div className="space-x-4">
        <button className="rounded bg-blue-600 px-6 py-2 hover:bg-blue-700">
          View Fleet
        </button>
        <button 
          onClick={async () => {
            await supabase.auth.signOut()
            router.push('/login')
          }}
          className="rounded bg-red-600 px-6 py-2 hover:bg-red-700"
        >
          Logout
        </button>
      </div>

      <div className="mt-8 text-sm text-gray-500">
        (Full dashboard coming in next step)
      </div>
    </div>
  )
}