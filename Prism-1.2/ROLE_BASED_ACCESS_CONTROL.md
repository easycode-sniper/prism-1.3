# PHASE 8: ROLE-BASED ACCESS CONTROL (RBAC)

## Overview

This document defines the role-based access control system for the OMD Fleet Route Verification application.

The system implements two roles:
- **ADMIN** - Full access including user management and admin panel
- **STANDARD_USER** - Normal operational access without administrative privileges

---

## 1. DATABASE SCHEMA EXTENSIONS

### 1.1 Profiles Table Enhancement

The `profiles` table must include role information:

```sql
CREATE TYPE user_role AS ENUM ('ADMIN', 'STANDARD_USER');

ALTER TABLE profiles 
ADD COLUMN role user_role NOT NULL DEFAULT 'STANDARD_USER',
ADD COLUMN disabled BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN invited_by UUID REFERENCES auth.users(id),
ADD COLUMN invited_at TIMESTAMPTZ,
ADD COLUMN last_login_at TIMESTAMPTZ;

-- Index for role-based queries
CREATE INDEX idx_profiles_role ON profiles(role);
CREATE INDEX idx_profiles_disabled ON profiles(disabled);
CREATE INDEX idx_profiles_active ON profiles(disabled, role);
```

### 1.2 Initial Admin Setup

The first user to sign up should automatically become an ADMIN, or you can manually set up an initial admin:

```sql
-- Option A: First user becomes admin (trigger)
CREATE OR REPLACE FUNCTION make_first_user_admin()
RETURNS TRIGGER AS $$
DECLARE
  user_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO user_count FROM profiles;
  
  IF user_count = 0 THEN
    NEW.role := 'ADMIN';
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_first_user_admin
  BEFORE INSERT ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION make_first_user_admin();

-- Option B: Manually create initial admin (run once in Supabase SQL Editor)
-- Replace with your actual user ID after creating the first user
UPDATE profiles 
SET role = 'ADMIN' 
WHERE id = 'YOUR_USER_ID_HERE';
```

---

## 2. ROW LEVEL SECURITY (RLS) POLICIES

### 2.1 Profiles Table Policies

```sql
-- Enable RLS on profiles
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Policy: Users can read their own profile
CREATE POLICY "Users can read own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

-- Policy: Admins can read all profiles
CREATE POLICY "Admins can read all profiles"
  ON profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- Policy: Users can update their own profile (limited fields)
CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id AND
    -- Prevent self-role-change
    role = (SELECT role FROM profiles WHERE id = auth.uid()) AND
    -- Prevent self-enable if disabled by admin
    disabled = (SELECT disabled FROM profiles WHERE id = auth.uid())
  );

-- Policy: Admins can update any profile (except their own role)
CREATE POLICY "Admins can update all profiles"
  ON profiles FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  )
  WITH CHECK (
    -- Admins cannot change their own role
    NOT (id = auth.uid() AND NEW.role != OLD.role)
  );

-- Policy: Only admins can insert new profiles (via invite flow)
CREATE POLICY "Admins can insert profiles"
  ON profiles FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );
```

### 2.2 Operational Data Policies

All operational tables should have similar RLS policies:

```sql
-- Example for dispatches table
ALTER TABLE dispatches ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read dispatches
CREATE POLICY "Users can read dispatches"
  ON dispatches FOR SELECT
  USING (auth.uid() IN (
    SELECT id FROM profiles WHERE disabled = FALSE
  ));

-- All authenticated users can create dispatches
CREATE POLICY "Users can create dispatches"
  ON dispatches FOR INSERT
  WITH CHECK (auth.uid() IN (
    SELECT id FROM profiles WHERE disabled = FALSE
  ));

-- Users can update dispatches they created, admins can update all
CREATE POLICY "Users can update own dispatches"
  ON dispatches FOR UPDATE
  USING (
    created_by = auth.uid() OR
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- Same pattern for runs, run_history, notifications, etc.
```

---

## 3. SUPABASE AUTH CONFIGURATION

### 3.1 Email/Password Authentication Setup

In your Supabase Dashboard:

1. Go to **Authentication** → **Providers**
2. Enable **Email** provider
3. Configure:
   - Enable email signup: ✓
   - Confirm email: Optional (disable for faster onboarding)
   - Allow duplicate emails: ✗

### 3.2 User Metadata

Store additional user information in `raw_user_meta_data`:

```javascript
// During signup
const { data, error } = await supabase.auth.signUp({
  email: 'user@example.com',
  password: 'securepassword',
  options: {
    data: {
      display_name: 'John Doe',
      role: 'STANDARD_USER' // This will be overridden by trigger/policy
    }
  }
});
```

---

## 4. FRONTEND AUTHENTICATION IMPLEMENTATION

### 4.1 Auth State Management

```javascript
// src/lib/auth.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export async function getSession() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) throw error;
  return session;
}

export async function getCurrentUser() {
  const session = await getSession();
  if (!session) return null;
  
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, email, display_name, role, disabled')
    .eq('id', session.user.id)
    .single();
    
  if (error || !profile || profile.disabled) {
    await supabase.auth.signOut();
    return null;
  }
  
  return profile;
}

export async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });
  
  if (error) throw error;
  
  // Check if user is disabled
  const profile = await getCurrentUser();
  if (!profile) {
    await supabase.auth.signOut();
    throw new Error('Account has been disabled. Contact an administrator.');
  }
  
  // Update last login
  await supabase
    .from('profiles')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', profile.id);
    
  return profile;
}

export async function logout() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export function isAdmin(user) {
  return user?.role === 'ADMIN';
}

export function canAccessAdminPanel(user) {
  return user?.role === 'ADMIN' && !user.disabled;
}
```

### 4.2 Protected Routes

```javascript
// src/middleware/auth.js
export async function protectRoute(to, from, next) {
  const session = await getSession();
  
  if (!session) {
    next('/login');
    return;
  }
  
  const user = await getCurrentUser();
  
  if (!user) {
    next('/login');
    return;
  }
  
  // Check admin-only routes
  if (to.path.startsWith('/admin') && user.role !== 'ADMIN') {
    next('/dashboard');
    return;
  }
  
  next();
}
```

---

## 5. ADMIN PANEL FEATURES

### 5.1 User Management View

The Admin Panel should include:

```
/admin/users
├── User List
│   ├── Email
│   ├── Display Name
│   ├── Role (ADMIN/STANDARD_USER)
│   ├── Status (Active/Disabled)
│   ├── Last Login
│   └── Actions
│       ├── Change Role
│       ├── Disable/Enable
│       └── Reset Password (email trigger)
│
├── Invite User Button
│   ├── Email input
│   ├── Role selector
│   └── Send invite
│
└── Audit Log (optional)
    ├── User created
    ├── Role changed
    ├── Account disabled/enabled
    └── Password reset requested
```

### 5.2 Admin Settings View

```
/admin/settings
├── Application Parameters
│   ├── Polling intervals
│   ├── Thresholds
│   ├── Notification settings
│   └── Wialon configuration
│
└── System Information
    ├── Total users
    ├── Active users
    ├── Total dispatches
    └── System stats
```

---

## 6. PERMISSION MATRIX

| Feature                          | ADMIN | STANDARD_USER |
|----------------------------------|-------|---------------|
| View Dashboard                   | ✓     | ✓             |
| View Fleet Monitoring            | ✓     | ✓             |
| Create Dispatches                | ✓     | ✓             |
| Manage Active Runs               | ✓     | ✓             |
| View Queue                       | ✓     | ✓             |
| View Fleet Information           | ✓     | ✓             |
| View Driver Information          | ✓     | ✓             |
| View History                     | ✓     | ✓             |
| Receive Notifications            | ✓     | ✓             |
| View Geofences                   | ✓     | ✓             |
| Route Monitoring                 | ✓     | ✓             |
| Speed Monitoring                 | ✓     | ✓             |
| Arrival Monitoring               | ✓     | ✓             |
| View Maps                        | ✓     | ✓             |
| Search & Filtering               | ✓     | ✓             |
| **Access Admin Panel**           | ✓     | ✗             |
| **Manage Users**                 | ✓     | ✗             |
| **Invite Users**                 | ✓     | ✗             |
| **Disable/Enable Users**         | ✓     | ✗             |
| **Change User Roles**            | ✓     | ✗             |
| **Modify App Parameters**        | ✓     | ✗             |
| **Access Admin-Only Data**       | ✓     | ✗             |
| **View Audit Logs**              | ✓     | ✗             |

---

## 7. API ROUTES (VERCEL SERVERLESS)

### 7.1 Admin-Only API Endpoints

```javascript
// api/admin/users/route.js
import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';

export async function GET(request) {
  const supabase = createServerClient(/* ... */);
  
  // Verify admin status
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
    
  if (profile?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  
  // Fetch all users
  const { data: users, error } = await supabase
    .from('profiles')
    .select('id, email, display_name, role, disabled, created_at, last_login_at');
    
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  
  return NextResponse.json(users);
}

export async function POST(request) {
  // Similar admin check, then create/update user
}
```

### 7.2 User Management Operations

```javascript
// api/admin/users/[id]/role/route.js
export async function PATCH(request, { params }) {
  const { id } = params;
  const { role } = await request.json();
  
  // Validate role
  if (!['ADMIN', 'STANDARD_USER'].includes(role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
  }
  
  // Admin check (omitted for brevity)
  
  // Update role
  const { error } = await supabase
    .from('profiles')
    .update({ role })
    .eq('id', id);
    
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  
  return NextResponse.json({ success: true });
}

// api/admin/users/[id]/disable/route.js
export async function POST(request, { params }) {
  const { id } = params;
  const { disabled } = await request.json();
  
  // Prevent disabling last admin
  if (disabled) {
    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .eq('role', 'ADMIN')
      .eq('disabled', false);
      
    if (admins.length === 1 && admins[0].id === id) {
      return NextResponse.json(
        { error: 'Cannot disable the last active admin' }, 
        { status: 400 }
      );
    }
  }
  
  // Update disabled status
  const { error } = await supabase
    .from('profiles')
    .update({ disabled })
    .eq('id', id);
    
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  
  return NextResponse.json({ success: true });
}
```

---

## 8. INVITE FLOW

### 8.1 Admin Invites User

```javascript
// Admin enters email → sends invite
async function inviteUser(email, role, invitedBy) {
  const supabase = createClient(/* ... */);
  
  // Generate temporary token or use Supabase invites
  const { data, error } = await supabase.functions.invoke('invite-user', {
    body: { email, role, invited_by: invitedBy }
  });
  
  return data;
}
```

### 8.2 Edge Function for Invites

```typescript
// supabase/functions/invite-user/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

serve(async (req) => {
  const { email, role, invited_by } = await req.json();
  
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } }
  );
  
  // Create user with temp password
  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    data: { role, invited_by }
  });
  
  if (error) return new Response(JSON.stringify({ error }), { status: 400 });
  
  return new Response(JSON.stringify(data));
});
```

---

## 9. SESSION MANAGEMENT

### 9.1 Session Persistence

- Sessions persist across browser restarts
- Sessions expire after 1 week (configurable in Supabase)
- Refresh tokens automatically rotate
- Disabled users are logged out on next token refresh

### 9.2 Handling Disabled Users

```javascript
// Listen for auth changes
supabase.auth.onAuthStateChange(async (event, session) => {
  if (event === 'TOKEN_REFRESHED' && session) {
    // Check if user was disabled
    const { data: profile } = await supabase
      .from('profiles')
      .select('disabled')
      .eq('id', session.user.id)
      .single();
      
    if (profile?.disabled) {
      await supabase.auth.signOut();
      window.location.href = '/login?disabled=1';
    }
  }
  
  if (event === 'SIGNED_OUT') {
    window.location.href = '/login';
  }
});
```

---

## 10. MIGRATION FROM CURRENT SYSTEM

### 10.1 Current State

- Uses Wialon token-based authentication only
- No user accounts in application
- No persistent operational data
- All state is runtime/browser-based

### 10.2 Migration Steps

1. **Set up Supabase project**
   - Create project
   - Enable Email/Password auth
   - Run database migrations

2. **Create initial admin account**
   - Sign up first user
   - Manually set role to ADMIN in database

3. **Update frontend authentication**
   - Replace Wialon-only auth with Supabase Auth
   - Keep Wialon integration for telemetry only

4. **Migrate operational data**
   - Move from localStorage/runtime state to Supabase tables
   - Ensure data persists across sessions

5. **Implement RBAC UI**
   - Add login/logout screens
   - Add admin panel
   - Add user management views

6. **Test multi-user scenarios**
   - Employee A creates dispatch
   - Employee B sees same dispatch
   - Shift handoff works correctly

---

## 11. SECURITY CONSIDERATIONS

### 11.1 Best Practices

- Never expose `SUPABASE_SERVICE_ROLE_KEY` in frontend code
- Use RLS for all data access control
- Validate roles on both client and server
- Log admin actions for audit trail
- Implement rate limiting on auth endpoints
- Use HTTPS everywhere

### 11.2 Common Pitfalls to Avoid

❌ Don't trust client-side role checks alone
❌ Don't store passwords in custom tables
❌ Don't allow users to self-promote to admin
❌ Don't forget to check `disabled` status
❌ Don't skip RLS policies assuming API checks are enough

---

## 12. TESTING CHECKLIST

- [ ] Standard user can log in
- [ ] Standard user can access all normal features
- [ ] Standard user CANNOT access /admin routes
- [ ] Standard user CANNOT see admin API responses
- [ ] Admin can log in
- [ ] Admin can access admin panel
- [ ] Admin can view all users
- [ ] Admin can change user roles
- [ ] Admin can disable/enable users
- [ ] Disabled user is logged out automatically
- [ ] Last admin cannot be disabled
- [ ] Operational data persists across user sessions
- [ ] Employee A's dispatches visible to Employee B
- [ ] RLS policies prevent unauthorized access

---

## WHAT YOU NEED TO DO NOW

### Step 1: Create Supabase Project
1. Go to https://supabase.com
2. Click "New Project"
3. Fill in project details
4. Wait for provisioning (~2 minutes)

### Step 2: Enable Email Authentication
1. In Supabase Dashboard → Authentication → Providers
2. Enable Email provider
3. Disable email confirmation (for now, can enable later)

### Step 3: Run Database Migrations
Copy the SQL from Section 1 and 2 into Supabase SQL Editor and run it.

### Step 4: Get Your Credentials
1. Go to Project Settings → API
2. Copy:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - anon/public key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - service_role key → `SUPABASE_SERVICE_ROLE_KEY` (keep secret!)

### Step 5: Create Initial Admin
After running migrations, sign up your first user, then run:
```sql
UPDATE profiles SET role = 'ADMIN' WHERE email = 'your-admin-email@example.com';
```

---

## NEXT STEPS

After implementing RBAC:
- Phase 9: Implement the Admin Panel UI
- Phase 10: Implement user invitation flow
- Phase 11: Add audit logging
- Phase 12: Multi-user testing and validation
