# The agent compiles against the androidx view-tree owner APIs but does not ship them (they are
# compileOnly): a host without them must not fail to shrink on the missing references.
-dontwarn androidx.lifecycle.**
-dontwarn androidx.savedstate.**
-dontwarn androidx.activity.**
