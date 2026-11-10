pub mod claim;
pub mod close_schedule;
pub mod create_schedule;
pub mod revoke;

// Glob re-exports lift the Accounts structs and anchor's generated
// pub(crate) __client_accounts_* modules to the crate root, where the
// #[program] macro and lib.rs references expect to find them. The
// per-module handler symbols share a name, which is expected here.
#[allow(ambiguous_glob_reexports)]
pub use claim::*;
#[allow(ambiguous_glob_reexports)]
pub use close_schedule::*;
#[allow(ambiguous_glob_reexports)]
pub use create_schedule::*;
#[allow(ambiguous_glob_reexports)]
pub use revoke::*;
