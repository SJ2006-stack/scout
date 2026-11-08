package app.scout

import com.google.firebase.auth.FirebaseUser
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions

class UserProfile(private val db: FirebaseFirestore) {
    fun save(user: FirebaseUser, onResult: (Exception?) -> Unit) {
        val ref = db.collection(USERS).document(user.uid)
        ref.get()
            .addOnSuccessListener { snap ->
                val data = hashMapOf<String, Any>(
                    "uid" to user.uid,
                    "email" to (user.email ?: ""),
                    "displayName" to (user.displayName ?: ""),
                    "photoUrl" to (user.photoUrl?.toString() ?: ""),
                    "updatedAt" to FieldValue.serverTimestamp(),
                )
                if (!snap.exists()) {
                    data["createdAt"] = FieldValue.serverTimestamp()
                }
                ref.set(data, SetOptions.merge())
                    .addOnSuccessListener { onResult(null) }
                    .addOnFailureListener { onResult(it) }
            }
            .addOnFailureListener { onResult(it) }
    }

    companion object {
        const val DATABASE = "scout"
        private const val USERS = "users"
    }
}
